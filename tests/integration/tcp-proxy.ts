import { createConnection, createServer, type AddressInfo, type Server, type Socket } from "node:net";

export interface TcpProxy {
  /** The test database's URL, through the proxy. */
  url: string;
  /** Drops every connection and refuses new ones, as a PostgreSQL that restarts. */
  down(): Promise<void>;
  /** Accepts connections again, on the same port. */
  up(): Promise<void>;
  close(): Promise<void>;
}

/** A TCP proxy to the PostgreSQL in `databaseUrl` that can go down and come back. */
export async function startTcpProxy(databaseUrl: string): Promise<TcpProxy> {
  const target = new URL(databaseUrl);
  const sockets = new Set<Socket>();
  let server: Server | undefined;
  let port = 0;

  async function up() {
    const listening = createServer((client) => {
      const upstream = createConnection({ host: target.hostname, port: Number(target.port || 5432) });
      for (const socket of [client, upstream]) {
        sockets.add(socket);
        socket.on("error", () => {
          client.destroy();
          upstream.destroy();
        });
        socket.on("close", () => sockets.delete(socket));
      }
      client.pipe(upstream).pipe(client);
    });
    await new Promise<void>((resolve) => listening.listen(port, "127.0.0.1", resolve));
    port = (listening.address() as AddressInfo).port;
    server = listening;
  }

  async function down() {
    const listening = server;
    server = undefined;
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    if (listening) await new Promise<void>((resolve) => listening.close(() => resolve()));
  }

  await up();
  const url = new URL(target);
  url.hostname = "127.0.0.1";
  url.port = String(port);
  return { url: url.toString(), down, up, close: down };
}
