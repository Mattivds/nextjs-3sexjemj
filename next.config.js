/** @type {import('next').NextConfig} */
const nextConfig = {
  optimizeFonts: false,
  output: 'standalone',
  experimental: {
    optimizePackageImports: ['date-fns']
  }
}

module.exports = nextConfig
