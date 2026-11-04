export interface SupabaseAdminUser {
  is_anonymous?: boolean;
  app_metadata?: {
    provider?: string;
    providers?: string[];
  };
  identities?: Array<{ provider?: string | null }>;
}

export interface GitHubReleaseAsset {
  download_count?: number | null;
}

export interface GitHubRelease {
  assets?: GitHubReleaseAsset[] | null;
}

export interface SupabaseUserStats {
  registeredUsers: number;
  discordLinkedUsers: number;
}

export function isDiscordLinkedUser(user: SupabaseAdminUser): boolean {
  const providers = [
    ...(Array.isArray(user.app_metadata?.providers) ? user.app_metadata.providers : []),
    user.app_metadata?.provider,
    ...(user.identities ?? []).map((identity) => identity.provider ?? undefined),
  ];

  return providers.some((provider) => provider?.toLowerCase() === "discord");
}

export function sumReleaseDownloads(releases: GitHubRelease[]): number {
  return releases.reduce(
    (total, release) =>
      total +
      (release.assets ?? []).reduce(
        (assetTotal, asset) =>
          assetTotal + Math.max(0, Math.trunc(asset.download_count ?? 0)),
        0,
      ),
    0,
  );
}

export async function fetchSupabaseUserStats(
  supabaseUrl: string,
  serviceRoleKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SupabaseUserStats> {
  const baseUrl = supabaseUrl.replace(/\/+$/, "");
  const perPage = 1000;
  let page = 1;
  let registeredUsers = 0;
  let discordLinkedUsers = 0;
  let reportedTotal: number | null = null;

  while (true) {
    const response = await fetchImpl(
      `${baseUrl}/auth/v1/admin/users?page=${page}&per_page=${perPage}`,
      {
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(15_000),
      },
    );

    if (!response.ok) {
      throw new Error(`Supabase Auth Admin API returned HTTP ${response.status}`);
    }

    const payload = (await response.json()) as { users?: SupabaseAdminUser[] };
    if (!Array.isArray(payload.users)) {
      throw new Error("Supabase Auth Admin API returned an unexpected users payload");
    }

    registeredUsers += payload.users.length;
    discordLinkedUsers += payload.users.filter(isDiscordLinkedUser).length;

    const totalHeaderValue = response.headers.get("x-total-count");
    const totalHeader = totalHeaderValue === null ? Number.NaN : Number(totalHeaderValue);
    if (Number.isFinite(totalHeader) && totalHeader >= 0) {
      reportedTotal = totalHeader;
    }

    if (payload.users.length < perPage) break;
    page += 1;
  }

  return {
    registeredUsers: reportedTotal ?? registeredUsers,
    discordLinkedUsers,
  };
}

export async function fetchGitHubDownloadCount(
  repository: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  const [owner, repo] = repository.split("/");
  if (!owner || !repo || repository.split("/").length !== 2) {
    throw new Error("GITHUB_REPOSITORY must be owner/repo");
  }

  const releases: GitHubRelease[] = [];
  const perPage = 100;
  let page = 1;

  while (true) {
    const response = await fetchImpl(
      `https://api.github.com/repos/${owner}/${repo}/releases?per_page=${perPage}&page=${page}`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal: AbortSignal.timeout(15_000),
      },
    );

    if (!response.ok) {
      throw new Error(`GitHub Releases API returned HTTP ${response.status}`);
    }

    const batch = (await response.json()) as GitHubRelease[];
    if (!Array.isArray(batch)) {
      throw new Error("GitHub Releases API returned an unexpected payload");
    }

    releases.push(...batch);
    if (batch.length < perPage) break;
    page += 1;
  }

  return sumReleaseDownloads(releases);
}
