/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The assistant route reads the fitted category files from disk; ship them with it on Vercel.
  outputFileTracingIncludes: { "/api/ask": ["./public/data/*.json"] },
};
export default nextConfig;
