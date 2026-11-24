// Every request a dispatched script's global fetch() makes lands here, if the runtime routes it here.
export default {
  fetch(request) {
    return new Response(`refused by the namespace outbound worker: ${new URL(request.url).host}`, { status: 403 });
  },
};
