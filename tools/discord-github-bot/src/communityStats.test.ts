import assert from "node:assert/strict";
import test from "node:test";
import {
  isDiscordLinkedUser,
  sumReleaseDownloads,
  type GitHubRelease,
  type SupabaseAdminUser,
} from "./communityStats.js";

test("counts Discord links from app metadata and linked identities", () => {
  const users: SupabaseAdminUser[] = [
    { is_anonymous: true, app_metadata: { providers: [] } },
    { app_metadata: { providers: ["discord"] } },
    { app_metadata: { provider: "discord", providers: ["discord", "email"] } },
    { identities: [{ provider: "discord" }] },
    { app_metadata: { providers: ["email"] } },
  ];

  assert.equal(users.filter(isDiscordLinkedUser).length, 3);
});

test("sums release asset downloads without counting releases themselves", () => {
  const releases: GitHubRelease[] = [
    { assets: [{ download_count: 12 }, { download_count: 8 }] },
    { assets: [{ download_count: 4 }] },
    { assets: [] },
    {},
  ];

  assert.equal(sumReleaseDownloads(releases), 24);
});

test("ignores missing and negative download counts", () => {
  const releases: GitHubRelease[] = [
    { assets: [{ download_count: null }, { download_count: -5 }, {}] },
  ];

  assert.equal(sumReleaseDownloads(releases), 0);
});
