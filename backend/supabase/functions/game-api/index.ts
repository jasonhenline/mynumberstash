import { createGameHandler } from "./handler.ts";

function required(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing configuration: ${name}`);
  return value;
}

Deno.serve(createGameHandler({
  supabaseUrl: required("SUPABASE_URL"),
  anonKey: required("SUPABASE_ANON_KEY"),
  serviceRoleKey: required("SUPABASE_SERVICE_ROLE_KEY"),
  allowedOrigins: (Deno.env.get("ALLOWED_ORIGINS") ?? "http://localhost:5173")
    .split(",").map((s) => s.trim()),
}));
