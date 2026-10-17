import { Hono } from 'hono';

/**
 * Browser front door. Mounted at `/`.
 *
 * @returns The welcome route group.
 */
export function welcomeRoutes(): Hono {
  return new Hono().get('/', (c) => c.html(welcomePage()));
}

function welcomePage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>OpenCryptoPay API</title>
  <meta name="description" content="Welcome to the OpenCryptoPay API. The public place map, its filters, and a health check.">
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%232231ef'/%3E%3C/svg%3E">
  <style>
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background: #f7f7f9;
      color: #283348;
      font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
      line-height: 1.5;
    }
    main {
      max-width: 40rem;
      margin: 0 auto;
      padding: 4.5rem 1.5rem 3rem;
    }
    .mark {
      margin: 0 0 1.5rem;
      font-size: 0.78rem;
      font-weight: 700;
      letter-spacing: 0.14em;
      color: #092f62;
    }
    h1 {
      margin: 0 0 0.75rem;
      font-size: 2.25rem;
      font-weight: 600;
      letter-spacing: -0.03em;
      line-height: 1.15;
    }
    .lead { margin: 0 0 2rem; font-size: 1.125rem; }
    .lead a { color: #2231ef; }
    section {
      background: #fff;
      border: 1px solid #e5e6eb;
      border-radius: 16px;
      padding: 0.25rem 1.25rem;
    }
    a.row {
      display: flex;
      justify-content: space-between;
      gap: 1rem;
      align-items: baseline;
      padding: 0.95rem 0;
      border-top: 1px solid #e5e6eb;
      color: inherit;
      text-decoration: none;
    }
    section a.row:first-child { border-top: 0; }
    a.row:hover .name { color: #2231ef; }
    .name { font-weight: 600; }
    .path {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 0.85rem;
      color: #5d647b;
    }
    footer { margin-top: 1.5rem; color: #5d647b; }
    footer a { color: #2231ef; }
  </style>
</head>
<body>
  <main>
    <p class="mark">OPEN CRYPTOPAY</p>
    <h1>Welcome</h1>
    <p class="lead">This is the OpenCryptoPay API. It serves the public place map: shops where you can pay with OpenCryptoPay. The payment standard, the wallets, and how a merchant offers it are on <a href="https://opencryptopay.io">opencryptopay.io</a>.</p>
    <section>
      <a class="row" href="/map/places"><span class="name">Places</span><span class="path">GET /map/places</span></a>
      <a class="row" href="/map/filters"><span class="name">Filters</span><span class="path">GET /map/filters</span></a>
      <a class="row" href="/healthz"><span class="name">Health</span><span class="path">GET /healthz</span></a>
    </section>
    <footer>You are on the API host, not the website.</footer>
  </main>
</body>
</html>
`;
}
