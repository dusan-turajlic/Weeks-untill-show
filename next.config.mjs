/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The meal-plan planner dynamically imports the WebLLM + brotli ESM bundles
  // straight from a CDN via `import(/* webpackIgnore: true */ url)`. Webpack
  // honors that magic comment and leaves the import as a native runtime import
  // of the CDN URL. Turbopack's handling is unreliable, so the build/dev use
  // the default webpack builder (no `--turbopack`).
  webpack(config) {
    return config;
  },
};

export default nextConfig;
