import { expect, it, spyOn } from "bun:test";
import { herdrRpc } from "./client.ts";

it.each([false, true])("drains a partial RPC frame without losing bytes, cancelling when permission lapses: %s", async (cancel) => {
  const text = "한글 🐑".repeat(40);
  const chunks: Buffer[] = [];
  let allowed = true;
  let writes = 0;
  let closed = 0;
  const connect = spyOn(Bun, "connect").mockImplementation(async <Data>(options: Bun.TCPSocketConnectOptions<Data> | Bun.UnixSocketOptions<Data>) => {
    const socket = {
      end() { closed++; },
      write(data: Uint8Array) {
        const count = writes++ < 2 ? writes - 2 : Math.min(7, data.length);
        if (count > 0) chunks.push(Buffer.from(data.subarray(0, count)));
        const received = Buffer.concat(chunks);
        if (cancel && count > 0) allowed = false;
        queueMicrotask(() => {
          if (received.at(-1) === 10) {
            const request = JSON.parse(received.toString());
            options.socket.data?.(socket, Buffer.from(`${JSON.stringify({ id: request.id, result: request.params })}\n`));
          } else options.socket.drain?.(socket);
        });
        return count;
      },
    } as unknown as Bun.Socket<Data>;
    return socket;
  });
  try {
    const answer = herdrRpc("fixture.write", { text }, "unused", 1_000, () => allowed);
    if (cancel) {
      await expect(answer).rejects.toMatchObject({ code: "cancelled" });
      expect(Buffer.concat(chunks).length).toBe(7);
    } else {
      expect(await answer).toEqual({ text });
      expect(Buffer.concat(chunks).toString().split("\n")).toHaveLength(2);
    }
    expect(closed).toBe(1);
  } finally { connect.mockRestore(); }
});
