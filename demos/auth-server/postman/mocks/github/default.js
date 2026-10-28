const http = require('node:http');
const handler = require('./handler.cjs');
http.createServer(handler).listen(process.env.PORT);
