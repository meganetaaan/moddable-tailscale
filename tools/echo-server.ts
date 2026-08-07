const requestedPort = Number(Deno.args[0] ?? "8080");
if (
  !Number.isInteger(requestedPort) || requestedPort < 1 || requestedPort > 65535
) {
  throw new RangeError("port must be between 1 and 65535");
}

console.log(`WebSocket echo server listening on 0.0.0.0:${requestedPort}/echo`);

Deno.serve({ hostname: "0.0.0.0", port: requestedPort }, (request) => {
  const url = new URL(request.url);
  if (url.pathname !== "/echo") {
    return new Response("Not found\n", { status: 404 });
  }
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return new Response("WebSocket upgrade required\n", { status: 426 });
  }

  const { socket, response } = Deno.upgradeWebSocket(request);
  socket.onopen = () => console.log("client connected");
  socket.onmessage = (event) => socket.send(event.data);
  socket.onerror = (event) => console.error("websocket error", event);
  socket.onclose = () => console.log("client disconnected");
  return response;
});
