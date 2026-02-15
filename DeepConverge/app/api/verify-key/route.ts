import { NextRequest } from "next/server";

export async function POST(request: NextRequest) {
  try {
    const { apiKey } = await request.json();

    if (!apiKey || typeof apiKey !== "string") {
      return Response.json(
        { valid: false, error: "API key is required" },
        { status: 400 }
      );
    }

    const response = await fetch("https://openrouter.ai/api/v1/models", {
      headers: {
        Authorization: `Bearer ${apiKey.trim()}`,
        "HTTP-Referer":
          process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000",
      },
    });

    if (response.ok) {
      return Response.json({ valid: true });
    }

    if (response.status === 401 || response.status === 403) {
      return Response.json({ valid: false, error: "Invalid API key" });
    }

    return Response.json({
      valid: false,
      error: `OpenRouter returned ${response.status}`,
    });
  } catch {
    return Response.json({
      valid: false,
      error: "Could not reach OpenRouter",
    });
  }
}
