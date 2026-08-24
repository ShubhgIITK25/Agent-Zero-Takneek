/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'export',
  distDir: process.env.NODE_ENV === 'production' ? 'renderer-out' : '.next',
  images: { unoptimized: true },
  // Electron loads files via file://, so assets must use relative paths.
  assetPrefix: './',
  trailingSlash: true,
};

module.exports = nextConfig;
