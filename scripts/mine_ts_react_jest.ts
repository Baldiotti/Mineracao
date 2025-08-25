'use strict';

const fs = require('fs');
const path = require('path');

// Configurações
const OUTPUT_DIR = 'output';
const CSV_FILE = path.join(OUTPUT_DIR, 'repos_ts_react_jest.csv');
const MAX_RESULTS_PER_QUERY = 500; // máx por query para limitar esforço
const BATCH_SIZE = 50; // 1..100 por paginação GraphQL
const SLEEP_BETWEEN_PAGES_MS = 1000;

// Token (Actions preenche GITHUB_TOKEN automaticamente)
const GITHUB_TOKEN =
  process.env.GITHUB_TOKEN || process.env.PAT || process.env.GH_TOKEN;

if (!GITHUB_TOKEN) {
  console.error(
    'Erro: GITHUB_TOKEN não encontrado. No Actions, use secrets.GITHUB_TOKEN. Localmente, exporte GITHUB_TOKEN ou use um .env.'
  );
  process.exit(1);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function ensureOutput() {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

function writeCsvHeaderIfNeeded() {
  ensureOutput();
  if (!fs.existsSync(CSV_FILE)) {
    fs.writeFileSync(
      CSV_FILE,
      'Repositorio,Estrelas,TypeScript,React,Jest\n',
      'utf-8'
    );
  }
}

function appendCsvRow({ nameWithOwner, stars, hasTS, hasReact, hasJest }) {
  const line = `${nameWithOwner},${stars},${hasTS ? 'Sim' : 'Não'},${
    hasReact ? 'Sim' : 'Não'
  },${hasJest ? 'Sim' : 'Não'}\n`;
  fs.appendFileSync(CSV_FILE, line);
}

async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs = 30000
) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(options.headers || {}),
      },
    });

    clearTimeout(id);
    return res;
  } catch (err) {
    clearTimeout(id);
    throw err;
  }
}

async function handleRateLimit(res) {
  // Se a API disser que o rate limit acabou, aguarde até o reset
  if (res.status === 403) {
    const remaining = res.headers.get('x-ratelimit-remaining');
    const reset = res.headers.get('x-ratelimit-reset');
    if (remaining === '0' && reset) {
      const resetEpoch = parseInt(reset, 10) * 1000;
      const waitMs = Math.max(0, resetEpoch - Date.now()) + 5000;
      console.warn(
        `Rate limit atingido. Aguardando ${(waitMs / 1000).toFixed(0)}s...`
      );
      await sleep(waitMs);
      return true; // sinaliza para tentar novamente
    }
  }
  return false;
}

async function ghGraphQL(query, variables) {
  while (true) {
    const res = await fetchWithTimeout('https://api.github.com/graphql', {
      method: 'POST',
      body: JSON.stringify({ query, variables }),
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (res.status === 403) {
      const willRetry = await handleRateLimit(res);
      if (willRetry) continue;
    }

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(
        `GraphQL falhou: ${res.status} - ${res.statusText} - ${txt.slice(
          0,
          500
        )}`
      );
    }

    const json = await res.json();
    if (json.errors) {
      const msg = JSON.stringify(json.errors);
      throw new Error(`GraphQL errors: ${msg}`);
    }
    return json.data;
  }
}

async function ghGET(url) {
  while (true) {
    const res = await fetchWithTimeout(url, { method: 'GET' });

    if (res.status === 403) {
      const willRetry = await handleRateLimit(res);
      if (willRetry) continue;
    }

    if (res.status === 404) return { status: 404 };
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(
        `GET ${url} falhou: ${res.status} - ${res.statusText} - ${txt.slice(
          0,
          500
        )}`
      );
    }

    const json = await res.json().catch(() => null);
    return { status: res.status, data: json };
  }
}

async function getRepoLanguages(owner, repo) {
  const { status, data } = await ghGET(
    `https://api.github.com/repos/${owner}/${repo}/languages`
  );
  if (status !== 200 || !data) return {};
  return data; // ex.: { TypeScript: 12345, JavaScript: 6789 }
}

async function getRepoTopics(owner, repo) {
  const { status, data } = await ghGET(
    `https://api.github.com/repos/${owner}/${repo}/topics`
  );
  if (status !== 200 || !data) return [];
  return Array.isArray(data.names) ? data.names : [];
}

async function getRepoContent(owner, repo, pathName) {
  const { status, data } = await ghGET(
    `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(
      pathName
    )}`
  );
  if (status !== 200 || !data) return null;
  if (data.encoding === 'base64' && data.content) {
    try {
      const decoded = Buffer.from(data.content, 'base64').toString('utf-8');
      return decoded;
    } catch {
      return null;
    }
  }
  return null;
}

function hasDep(pkgJson, name) {
  const deps = pkgJson.dependencies || {};
  const dev = pkgJson.devDependencies || {};
  return Boolean(deps[name] || dev[name]);
}

function pkgHasAnyDep(pkgJson, names) {
  return names.some((n) => hasDep(pkgJson, n));
}

function scriptsContain(pkgJson, term) {
  const scripts = pkgJson.scripts || {};
  return Object.values(scripts).some(
    (s) => typeof s === 'string' && s.toLowerCase().includes(term)
  );
}

// Heurísticas para TS/React/Jest
async function detectTech(owner, repo) {
  let hasTS = false;
  let hasReact = false;
  let hasJest = false;

  // 1) Linguagens
  const langs = await getRepoLanguages(owner, repo).catch(() => ({}));
  if (langs && typeof langs.TypeScript === 'number' && langs.TypeScript > 0) {
    hasTS = true;
  }

  // 2) package.json na raiz
  const pkgText = await getRepoContent(owner, repo, 'package.json');
  let pkgJson = null;
  if (pkgText) {
    try {
      pkgJson = JSON.parse(pkgText);
    } catch {}
  }

  if (pkgJson) {
    // React via deps
    if (pkgHasAnyDep(pkgJson, ['react', 'react-dom'])) {
      hasReact = true;
    }
    // TS via deps (fallback se linguagens não apontar)
    if (!hasTS && pkgHasAnyDep(pkgJson, ['typescript'])) {
      hasTS = true;
    }

    // Jest via deps ou scripts
    if (
      pkgHasAnyDep(pkgJson, [
        'jest',
        '@jest/globals',
        'ts-jest',
        'babel-jest',
      ]) ||
      scriptsContain(pkgJson, 'jest')
    ) {
      hasJest = true;
    }
  }

  // 3) Topics (às vezes repos marcam "react")
  if (!hasReact) {
    const topics = await getRepoTopics(owner, repo).catch(() => []);
    if (topics.map((t) => t.toLowerCase()).includes('react')) {
      hasReact = true;
    }
  }

  // 4) Arquivos de config que ajudam a confirmar
  if (!hasTS) {
    const tsconfig = await getRepoContent(owner, repo, 'tsconfig.json');
    const tsconfigBase = !tsconfig
      ? await getRepoContent(owner, repo, 'tsconfig.base.json')
      : null;
    if (tsconfig || tsconfigBase) hasTS = true;
  }

  if (!hasJest) {
    // Qualquer um desses existir na raiz
    const candidates = [
      'jest.config.js',
      'jest.config.cjs',
      'jest.config.mjs',
      'jest.config.ts',
      'jest.config.json',
    ];
    for (const file of candidates) {
      const content = await getRepoContent(owner, repo, file);
      if (content) {
        hasJest = true;
        break;
      }
    }
  }

  return { hasTS, hasReact, hasJest };
}

// Query GraphQL para buscar repositórios
const SEARCH_REPOS = `
query($queryString: String!, $first: Int!, $after: String) {
  search(query: $queryString, type: REPOSITORY, first: $first, after: $after) {
    repositoryCount
    edges {
      node {
        ... on Repository {
          name
          owner { login }
          stargazerCount
        }
      }
    }
    pageInfo {
      endCursor
      hasNextPage
    }
  }
}
`;

// Queries: tentamos várias combinações para encontrar candidatos
const QUERY_STRINGS = [
  // Foco: TS + React + Jest
  'language:TypeScript react jest sort:stars-desc',
  'language:TypeScript "react" "jest" in:name,description,readme sort:stars-desc',
  'language:TypeScript topic:react jest sort:stars-desc',
  // fallback ampliado
  'language:TypeScript react in:name,description,readme sort:stars-desc',
  'language:TypeScript jest in:name,description,readme sort:stars-desc',
];

async function main() {
  writeCsvHeaderIfNeeded();

  const processed = new Set();
  let totalQualified = 0;

  for (const queryString of QUERY_STRINGS) {
    console.log(`\n🔎 Iniciando query: "${queryString}"`);
    let foundThisQuery = 0;
    let after = null;

    while (foundThisQuery < MAX_RESULTS_PER_QUERY) {
      const vars = { queryString, first: BATCH_SIZE, after };

      let data;
      try {
        data = await ghGraphQL(SEARCH_REPOS, vars);
      } catch (err) {
        console.error(`❌ Erro GraphQL: ${err.message}`);
        break;
      }

      const edges = data?.search?.edges || [];
      if (edges.length === 0) {
        console.log('📄 Sem mais resultados nesta página.');
        break;
      }

      console.log(
        `📈 Disponíveis (aprox.): ${data.search.repositoryCount} | Página com ${edges.length} itens`
      );

      for (const edge of edges) {
        const repo = edge.node;
        const nameWithOwner = `${repo.owner.login}/${repo.name}`;

        if (processed.has(nameWithOwner)) continue;
        processed.add(nameWithOwner);

        console.log(
          `🔍 Analisando: ${nameWithOwner} (${repo.stargazerCount}⭐)`
        );

        try {
          const tech = await detectTech(repo.owner.login, repo.name);

          if (tech.hasTS && tech.hasReact && tech.hasJest) {
            appendCsvRow({
              nameWithOwner,
              stars: repo.stargazerCount,
              hasTS: true,
              hasReact: true,
              hasJest: true,
            });
            totalQualified++;
            foundThisQuery++;
            console.log(`✅ Registrado: ${nameWithOwner}`);
          } else {
            console.log(
              `❌ Não atende (TS:${tech.hasTS} React:${tech.hasReact} Jest:${tech.hasJest}): ${nameWithOwner}`
            );
          }
        } catch (err) {
          console.warn(`⚠️ Falha ao analisar ${nameWithOwner}: ${err.message}`);
        }
      }

      if (!data.search.pageInfo.hasNextPage) {
        console.log('🏁 Fim da paginação para esta query.');
        break;
      }
      after = data.search.pageInfo.endCursor;

      await sleep(SLEEP_BETWEEN_PAGES_MS);
    }

    console.log(
      `📊 Query finalizada: "${queryString}" | Qualificados: ${foundThisQuery}`
    );
    await sleep(1500);
  }

  console.log('\n🎉 ===== RESUMO =====');
  console.log(`🔢 Repositórios únicos analisados: ${processed.size}`);
  console.log(`✅ Repositórios (TS+React+Jest): ${totalQualified}`);
  console.log(`📁 CSV gerado: ${CSV_FILE}`);
}

main().catch((e) => {
  console.error('Erro fatal:', e);
  process.exit(1);
});
