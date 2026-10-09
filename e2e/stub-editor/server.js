// A stand-in for the ONLYOFFICE document server for the end-to-end test in CI: pulling and starting the real one
// takes minutes and gigabytes, and the test does not edit anything. It answers what the application asks the server
// when no editor is open: the health check (true) and the command service ("info" of a key nobody has open: error 1).
// The real server is covered by the manual checks in docs/PROJECT.md 7.4.
const http = require("node:http");

http
  .createServer((request, response) => {
    if (request.method === "GET" && request.url === "/healthcheck") {
      response.writeHead(200, { "Content-Type": "text/plain" }).end("true");
    } else if (request.method === "POST" && request.url?.startsWith("/command")) {
      request.resume();
      request.on("end", () => response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ error: 1 })));
    } else {
      response.writeHead(404).end();
    }
  })
  .listen(80, () => console.log("editor stand-in listening on 80"));
