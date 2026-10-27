/** The few GitHub REST calls the runbot needs, with pagination */

export interface GithubBranch {
  name: string;
  sha: string;
}

export interface GithubPull {
  number: number;
  title: string;
  author: string;
  draft: boolean;
  /** Base (target) branch */
  target: string;
  /** Head branch name, without the owner */
  headRef: string;
  headSha: string;
  /** owner/name of the head repository (a fork, or the repo itself) */
  headSlug: string;
}

export type StatusState = 'pending' | 'success' | 'failure' | 'error';

export interface GithubClient {
  listBranches(slug: string): Promise<GithubBranch[]>;
  listOpenPulls(slug: string): Promise<GithubPull[]>;
  setStatus(
    slug: string,
    sha: string,
    status: {
      state: StatusState;
      context: string;
      description: string;
      targetUrl?: string;
    },
  ): Promise<void>;
  /** Default branch and whether the token can read it */
  getRepo(slug: string): Promise<{ defaultBranch: string; private: boolean }>;
}

// GitHub owners: letters, digits, hyphens; repo names may have dots but aren't "." or ".."
const SLUG = /^[A-Za-z0-9-]{1,39}\/(?!\.{1,2}$)[A-Za-z0-9_.-]{1,100}$/;

export function createGithubClient(opts: {
  token?: string;
  apiBaseUrl?: string;
  fetchFn?: typeof fetch;
}): GithubClient {
  const base = (opts.apiBaseUrl ?? 'https://api.github.com').replace(/\/$/, '');
  const doFetch = opts.fetchFn ?? fetch;
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'iswe-backstage-runbot',
    ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
  };

  const check = (slug: string) => {
    if (!SLUG.test(slug)) throw new Error(`Not a GitHub owner/name: ${slug}`);
  };

  async function request(method: string, url: string, body?: unknown) {
    const res = await doFetch(url.startsWith('http') ? url : `${base}${url}`, {
      method,
      headers: body
        ? { ...headers, 'Content-Type': 'application/json' }
        : headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(
        `GitHub ${method} ${url}: HTTP ${res.status} ${text.slice(0, 200)}`,
      );
    }
    return res;
  }

  async function paginate<V>(path: string, limit = 1000): Promise<V[]> {
    const out: V[] = [];
    let url: string | undefined = `${base}${path}${
      path.includes('?') ? '&' : '?'
    }per_page=100`;
    while (url && out.length < limit) {
      const res = await request('GET', url);
      out.push(...((await res.json()) as V[]));
      const next = /<([^>]+)>;\s*rel="next"/.exec(
        res.headers.get('link') ?? '',
      );
      url = next?.[1];
    }
    return out;
  }

  return {
    async listBranches(slug) {
      check(slug);
      const rows = await paginate<any>(`/repos/${slug}/branches`);
      return rows.map(b => ({ name: b.name, sha: b.commit.sha }));
    },
    async listOpenPulls(slug) {
      check(slug);
      const rows = await paginate<any>(`/repos/${slug}/pulls?state=open`, 500);
      return rows.map(p => ({
        number: p.number,
        title: p.title,
        author: p.user?.login ?? '',
        draft: Boolean(p.draft),
        target: p.base.ref,
        headRef: p.head.ref,
        headSha: p.head.sha,
        headSlug: p.head.repo?.full_name ?? slug,
      }));
    },
    async setStatus(slug, sha, s) {
      check(slug);
      if (!/^[0-9a-f]{40}$/.test(sha))
        throw new Error(`Not a commit hash: ${sha}`);
      await request('POST', `/repos/${slug}/statuses/${sha}`, {
        state: s.state,
        context: s.context,
        description: s.description.slice(0, 140),
        ...(s.targetUrl ? { target_url: s.targetUrl } : {}),
      });
    },
    async getRepo(slug) {
      check(slug);
      const r = await (await request('GET', `/repos/${slug}`)).json();
      return { defaultBranch: r.default_branch, private: Boolean(r.private) };
    },
  };
}
