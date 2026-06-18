import { describe, expect, it } from 'vitest';
import { matchesTitle } from '../src/utils';

// NOTE: this file deliberately does NOT mock parse-torrent-title (unlike
// utils.test.ts) — the non-strict precision logic depends on the real parser
// extracting the show title (excluding episode subtitle / release group / tags).
//
// This is the permanent regression guard for the "Layer 1" precision fix: the
// loose (non-strict) series matcher compares the query's show-name words against
// the candidate's PARSED title with whole-word matching. It must drop release
// group / episode-subtitle false positives WITHOUT breaking real English titles.

describe('matchesTitle non-strict precision (real parse-torrent-title)', () => {
  // [candidate filename, query, expected]
  const englishMustMatch: Array<[string, string]> = [
    ['Breaking.Bad.S01E01.1080p.WEB-DL-GRP', 'Breaking Bad S01E01'],
    ['Game.of.Thrones.S03E05.1080p.BluRay-x', 'Game of Thrones S03E05'],
    // metadata title "The Office" vs a US-suffixed release
    ['The.Office.US.S01E01.720p.HDTV.x264-LOL', 'The Office S01E01'],
    ['The.Office.US.S01E01.720p.HDTV.x264-LOL', 'The Office US S01E01'],
    ['Marvels.Agents.of.SHIELD.S01E01.1080p-XYZ', "Marvel's Agents of S.H.I.E.L.D. S01E01"],
    ['Stranger.Things.S04E01.2160p.HDR-NTb', 'Stranger Things S04E01'],
    ['The.Mandalorian.S02E04.1080p.WEB-GRP', 'The Mandalorian S02E04'],
    ['Its.Always.Sunny.in.Philadelphia.S05E01.HDTV-x', "It's Always Sunny in Philadelphia S05E01"],
    ['Brooklyn.Nine-Nine.S01E01.1080p-GRP', 'Brooklyn Nine-Nine S01E01'],
    ['House.of.the.Dragon.S01E01.2160p-NTb', 'House of the Dragon S01E01'],
    ['Better.Call.Saul.S06E13.1080p-GRP', 'Better Call Saul S06E13'],
    ['The.Walking.Dead.S10E16.720p.WEB-x', 'The Walking Dead S10E16'],
    ['Mr.Robot.S01E01.1080p.WEB-GRP', 'Mr. Robot S01E01'],
    ['9-1-1.S01E01.1080p.WEB-GRP', '9-1-1 S01E01'],
    ['Lost.S01E01.1080p.BluRay-GRP', 'Lost S01E01'],
    ['Friends.S01E01.1080p.BluRay-GRP', 'Friends S01E01'],
    ['Severance.S01E01.2160p.ATVP.WEB-GRP', 'Severance S01E01'],
    ['Andor.S01E01.1080p.DSNP.WEB-GRP', 'Andor S01E01'],
    ['Star.Wars.Andor.S01E01.1080p.DSNP.WEB-GRP', 'Andor S01E01'],
    ['Shogun.2024.S01E01.2160p.WEB-GRP', 'Shogun S01E01'],
  ];

  const danishMustMatch: Array<[string, string]> = [
    // group-prefixed NORDiC scene release must still match
    ['ballin-slangedraeber.s01e02.danish.1080p.web.h264', 'Slangedraeber S01E02'],
    ['loegnen.s01e01.danish.1080p.web.h264-dougal', 'loegnen S01E01'],
  ];

  const mustReject: Array<[string, string]> = [
    // query word "snake" only present via the release group "-SNAKE"; "killer"
    // only via the substring "killers"
    [
      'A.Shop.for.Killers.S01E04.The.Shopping.Mall.2160p.HULU.WEB-DL.H.265-SNAKE',
      'Snake Killer S01E04',
    ],
    // query word "loegnen" only present in the episode subtitle, not the show name
    ['sir.det.bar.s01e01.loegnen.danish.1080p.web.h264-d', 'loegnen S01E01'],
  ];

  it.each(englishMustMatch)('keeps English match: %s ~ %s', (cand, query) => {
    expect(matchesTitle(cand, query, false)).toBe(true);
  });

  it.each(danishMustMatch)('keeps real Danish match: %s ~ %s', (cand, query) => {
    expect(matchesTitle(cand, query, false)).toBe(true);
  });

  it.each(mustReject)('rejects group/subtitle false positive: %s ~ %s', (cand, query) => {
    expect(matchesTitle(cand, query, false)).toBe(false);
  });
});
