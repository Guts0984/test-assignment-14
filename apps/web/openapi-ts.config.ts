import { defineConfig } from '@hey-api/openapi-ts';

/** The browser client is generated from the api's OpenAPI document; nothing in it is written by hand. */
export default defineConfig({
  input: '../api/openapi.json',
  output: { path: 'src/shared/api/generated', format: false, lint: false },
  plugins: ['@hey-api/typescript', '@hey-api/client-fetch', '@hey-api/sdk', '@tanstack/react-query'],
});
