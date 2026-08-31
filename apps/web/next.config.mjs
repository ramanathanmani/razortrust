/**
 * The console talks to the Fastify API through a same-origin rewrite.
 *
 * That is deliberate: a bearer token in a cross-origin fetch would need CORS
 * on the API, and loosening CORS on a payments service to make a dashboard
 * work is a bad trade. Proxying keeps the API's behaviour untouched and the
 * browser sees one origin.
 */
const API_ORIGIN = process.env.RAZORTRUST_API_ORIGIN ?? 'http://localhost:8080';

/** @type {import('next').NextConfig} */
export default {
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${API_ORIGIN}/:path*` }];
  },
};
