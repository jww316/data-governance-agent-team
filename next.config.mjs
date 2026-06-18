/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // This project has its own lockfile; pin the tracing root to silence the
  // "multiple lockfiles" warning from an unrelated parent-directory lockfile.
  outputFileTracingRoot: import.meta.dirname,
};

export default nextConfig;
