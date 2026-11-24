export default {
  fetch(request) {
    return new Response(`outbound-saw ${new URL(request.url).host}`);
  },
};
