import OpenAI from "openai";

export const PROXY_URL = process.env.PROXY_URL || "http://127.0.0.1:8787";
export const PROXY_API_KEY = process.env.PROXY_API_KEY || "local";
export const PROXY_MODEL = process.env.PROXY_MODEL || "gpt-5.6-sol";

export const openai = new OpenAI({
  apiKey: PROXY_API_KEY,
  baseURL: `${PROXY_URL.replace(/\/$/, "")}/v1`,
});

export async function getHealth() {
  const response = await fetch(`${PROXY_URL.replace(/\/$/, "")}/healthz`);
  if (!response.ok) {
    throw new Error(`Health check failed (${response.status} ${response.statusText})`);
  }
  return response.json();
}
