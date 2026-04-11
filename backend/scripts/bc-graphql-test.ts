/**
 * BigCommerce Stencil GraphQL Storefront API — test harness.
 *
 * Verifies:
 *   1. JWT token scraping from a BC Stencil storefront page
 *   2. CORS origin extraction from JWT payload
 *   3. `newestProducts` query (page 1) — newest-first with createdAt
 *   4. Cursor-based pagination (page 2 — must differ from page 1)
 *   5. `products` query — full catalog walk (entity ID order)
 *
 * Usage:  npx tsx backend/scripts/bc-graphql-test.ts [origin] [tokenScrapeUrl]
 * Default: https://www.prophetriver.com /
 *
 * NOTE: Run with MSYS_NO_PATHCONV=1 on Git Bash to prevent path mangling:
 *   MSYS_NO_PATHCONV=1 npx tsx backend/scripts/bc-graphql-test.ts
 */

import axios from 'axios';

async function main() {
  const origin = process.argv[2] || 'https://www.prophetriver.com';
  const tokenScrapeUrl = process.argv[3] || '/';

  console.log(`\n=== BigCommerce Stencil GraphQL Test ===`);
  console.log(`Origin: ${origin}`);
  console.log(`Token scrape URL: ${origin}${tokenScrapeUrl}\n`);

  // Step 1: Scrape JWT token
  console.log('--- Step 1: Scraping JWT token ---');
  let token: string | null = null;
  let graphqlOrigin = origin;

  try {
    const resp = await axios.get(`${origin}${tokenScrapeUrl}`, {
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html',
      },
    });

    const html = typeof resp.data === 'string' ? resp.data : '';
    console.log(`  HTML length: ${html.length}`);

    // Find JWT (eyJ...) in the HTML
    const jwtMatch = html.match(/eyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/);
    if (jwtMatch) {
      token = jwtMatch[0];
      console.log(`  JWT found: ${token.slice(0, 20)}... (${token.length} chars)`);

      // Decode JWT payload for CORS origin
      try {
        const payloadB64 = token.split('.')[1];
        const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
        console.log(`  JWT payload: iss=${payload.iss}, sid=${payload.sid}, cors=${JSON.stringify(payload.cors)}`);
        if (Array.isArray(payload.cors) && payload.cors.length > 0) {
          graphqlOrigin = payload.cors[0];
          console.log(`  GraphQL origin (from cors): ${graphqlOrigin}`);
        }
      } catch (e) {
        console.log(`  JWT decode failed: ${e instanceof Error ? e.message : e}`);
      }
    } else {
      console.log('  No JWT found in HTML.');
      // Check for non-JWT tokens
      const tokenLines = html.split('\n')
        .filter((l: string) => /token/i.test(l) && l.length < 500)
        .slice(0, 5);
      if (tokenLines.length > 0) {
        console.log('  Lines containing "token":');
        tokenLines.forEach((l: string) => console.log(`    ${l.trim().slice(0, 200)}`));
      }
      console.log('\n  RESULT: TOKEN SCRAPE FAILED');
      return;
    }
  } catch (err) {
    console.log(`  Token scrape failed: ${err instanceof Error ? err.message : err}`);
    return;
  }

  const graphqlUrl = `${graphqlOrigin}/graphql`;
  console.log(`  GraphQL URL: ${graphqlUrl}`);

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/json',
    'Origin': graphqlOrigin,
  };

  const nodeFields = `
    entityId name path sku
    createdAt { utc }
    prices(currencyCode: CAD) {
      price { value currencyCode }
      salePrice { value }
    }
    defaultImage { url(width: 300) }
    availabilityV2 { status }
  `;

  // Step 2: newestProducts page 1
  console.log('\n--- Step 2: newestProducts (page 1, 5 products) ---');
  let newestCursor: string | null = null;
  let page1FirstName: string | null = null;

  try {
    const resp = await axios.post(graphqlUrl, {
      query: `{ site { newestProducts(first: 5) { pageInfo { hasNextPage endCursor } edges { node { ${nodeFields} } } } } }`,
    }, { timeout: 20000, headers });

    if (resp.data?.errors) {
      console.log(`  GraphQL errors: ${JSON.stringify(resp.data.errors).slice(0, 300)}`);
    }

    const data = resp.data?.data?.site?.newestProducts;
    if (!data) {
      console.log(`  newestProducts not available on this store.`);
      console.log(`  Response: ${JSON.stringify(resp.data).slice(0, 300)}`);
    } else {
      const edges = data.edges || [];
      console.log(`  Products: ${edges.length} | hasNextPage: ${data.pageInfo?.hasNextPage}`);
      newestCursor = data.pageInfo?.endCursor || null;

      for (const edge of edges) {
        const n = edge.node;
        page1FirstName = page1FirstName || n.name;
        const price = n.prices?.salePrice?.value ?? n.prices?.price?.value;
        console.log(`    ${n.entityId} | ${n.createdAt?.utc || 'N/A'} | $${price ?? 'N/A'} | ${n.name?.slice(0, 70)}`);
        if (edges.indexOf(edge) === 0) {
          console.log(`      path: ${n.path}`);
          console.log(`      sku: ${n.sku || 'N/A'} | availability: ${n.availabilityV2?.status || 'N/A'}`);
          console.log(`      image: ${(n.defaultImage?.url || 'N/A').slice(0, 80)}`);
        }
      }
    }
  } catch (err: any) {
    console.log(`  newestProducts query failed: ${err.message}`);
    if (err.response) {
      console.log(`  Status: ${err.response.status} | Data: ${JSON.stringify(err.response.data).slice(0, 200)}`);
    }
  }

  // Step 3: newestProducts page 2 (cursor)
  if (newestCursor) {
    console.log('\n--- Step 3: newestProducts (page 2, cursor) ---');
    try {
      const resp = await axios.post(graphqlUrl, {
        query: `query($after: String) { site { newestProducts(first: 5, after: $after) { pageInfo { hasNextPage endCursor } edges { node { entityId name createdAt { utc } } } } } }`,
        variables: { after: newestCursor },
      }, { timeout: 20000, headers });

      const data = resp.data?.data?.site?.newestProducts;
      const edges = data?.edges || [];
      console.log(`  Products: ${edges.length} | hasNextPage: ${data?.pageInfo?.hasNextPage}`);
      for (const edge of edges) {
        const n = edge.node;
        console.log(`    ${n.entityId} | ${n.createdAt?.utc || 'N/A'} | ${n.name?.slice(0, 70)}`);
      }

      if (edges.length > 0 && page1FirstName) {
        const p2First = edges[0].node.name;
        console.log(p2First === page1FirstName
          ? '\n  WARNING: Page 2 first product same as page 1!'
          : '\n  OK: Pagination works (different products on page 2)');
      }
    } catch (err: any) {
      console.log(`  Page 2 failed: ${err.message}`);
    }
  }

  // Step 4: products query (full catalog, entity ID order)
  console.log('\n--- Step 4: products (first 3, entity ID order) ---');
  try {
    const resp = await axios.post(graphqlUrl, {
      query: `{ site { products(first: 3) { pageInfo { hasNextPage endCursor } edges { node { entityId name createdAt { utc } } } } } }`,
    }, { timeout: 20000, headers });

    const data = resp.data?.data?.site?.products;
    if (data) {
      const edges = data.edges || [];
      console.log(`  Products: ${edges.length} | hasNextPage: ${data.pageInfo?.hasNextPage}`);
      for (const edge of edges) {
        const n = edge.node;
        console.log(`    ${n.entityId} | ${n.createdAt?.utc || 'N/A'} | ${n.name?.slice(0, 70)}`);
      }
    }
  } catch (err: any) {
    console.log(`  Products query failed: ${err.message}`);
  }

  console.log('\n=== Test complete ===\n');
}

main().catch(err => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
