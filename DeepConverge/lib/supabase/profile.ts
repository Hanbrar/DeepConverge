import type { SupabaseClient } from "@supabase/supabase-js";

export interface Profile {
  id: string;
  display_name: string | null;
  avatar_url: string | null;
  openrouter_api_key: string | null;
  is_approved: boolean;
  created_at: string;
}

export async function getProfile(
  supabase: SupabaseClient,
  userId: string
): Promise<Profile | null> {
  const { data, error } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", userId)
    .single();

  if (error) {
    console.warn("[profile] getProfile error:", error);
    return null;
  }
  return data;
}

export async function updateProfile(
  supabase: SupabaseClient,
  userId: string,
  updates: Partial<Pick<Profile, "display_name" | "openrouter_api_key">>
): Promise<boolean> {
  const { error } = await supabase
    .from("profiles")
    .update(updates)
    .eq("id", userId);

  if (error) {
    console.warn("[profile] updateProfile error:", error);
    return false;
  }
  return true;
}
