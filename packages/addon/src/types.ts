export type Stream = {
  name: string;
  url: string;
  description?: string;
  behaviorHints?: {
    notWebReady?: boolean;
    bingeGroup?: string;
    videoSize?: number; // exact file size in bytes (helps the player; UI hint)
    headers?: {
      [key: string]: string;
    };
    filename?: string;
  };
};
