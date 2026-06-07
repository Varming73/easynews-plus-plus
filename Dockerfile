FROM node:22-alpine AS builder

WORKDIR /build

# Copy LICENSE file.
COPY LICENSE ./

# Copy the custom-titles.json file.
COPY custom-titles.json ./

# Copy the relevant package.json and package-lock.json files.
COPY package*.json ./
COPY packages/addon/package*.json ./packages/addon/
COPY packages/api/package*.json ./packages/api/
COPY packages/shared/package*.json ./packages/shared/
# Copy the cloudflare-worker manifest too so `npm ci` sees the complete workspace
# set (defensive against npm versions that reject a missing workspace), even
# though this image only builds/runs the addon server.
COPY packages/cloudflare-worker/package*.json ./packages/cloudflare-worker/

# Install dependencies (clean, reproducible install from the committed lockfile).
RUN npm ci

# Copy source files.
COPY tsconfig.*json ./

COPY packages/addon ./packages/addon
COPY packages/api ./packages/api
COPY packages/shared ./packages/shared

# Build the project.
RUN npm run build

# Remove development dependencies.
RUN npm --workspaces prune --omit=dev

FROM node:22-alpine AS final

WORKDIR /app

COPY --from=builder /build/package*.json /build/LICENSE ./

# Copy the package.json files.
COPY --from=builder /build/packages/addon/package.*json ./packages/addon/
COPY --from=builder /build/packages/api/package.*json ./packages/api/
COPY --from=builder /build/packages/shared/package.*json ./packages/shared/

# Copy the dist files.
COPY --from=builder /build/packages/addon/dist ./packages/addon/dist
COPY --from=builder /build/packages/api/dist ./packages/api/dist
COPY --from=builder /build/packages/shared/dist ./packages/shared/dist

# Copy the custom-titles.json file.
COPY --from=builder /build/custom-titles.json ./custom-titles.json

COPY --from=builder /build/node_modules ./node_modules

# npm does not hoist every dependency to the root node_modules: the addon's
# express 5 subtree is nested under packages/addon/node_modules (a conflicting
# transitive version is hoisted to root, forcing express to nest). Copy the
# workspace-level node_modules too, or `import 'express'` fails at runtime with
# ERR_MODULE_NOT_FOUND.
COPY --from=builder /build/packages/addon/node_modules ./packages/addon/node_modules

# Run as the unprivileged 'node' user (present in the official node images)
# rather than root. The app only reads its files and binds a high port.
USER node

EXPOSE 1337

ENTRYPOINT ["npm", "run", "start"]