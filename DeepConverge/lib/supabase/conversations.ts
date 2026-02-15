import type { SupabaseClient } from "@supabase/supabase-js";

export interface Conversation {
  id: string;
  user_id: string;
  title: string;
  mode: "chat" | "debate";
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface DbMessage {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  reasoning: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export async function createConversation(
  supabase: SupabaseClient,
  userId: string,
  mode: "chat" | "debate",
  title: string
): Promise<string | null> {
  const { data, error } = await supabase
    .from("conversations")
    .insert({ user_id: userId, mode, title })
    .select("id")
    .single();

  if (error) {
    console.warn("[conversations] create error:", error);
    return null;
  }
  return data.id;
}

export async function saveMessage(
  supabase: SupabaseClient,
  conversationId: string,
  role: string,
  content: string,
  reasoning?: string,
  metadata?: Record<string, unknown>
): Promise<string | null> {
  const { data, error } = await supabase
    .from("messages")
    .insert({
      conversation_id: conversationId,
      role,
      content,
      reasoning: reasoning || null,
      metadata: metadata || {},
    })
    .select("id")
    .single();

  if (error) {
    console.warn("[conversations] saveMessage error:", error);
    return null;
  }
  return data.id;
}

export async function loadConversations(
  supabase: SupabaseClient,
  userId: string,
  mode?: "chat" | "debate"
): Promise<Conversation[]> {
  let query = supabase
    .from("conversations")
    .select("*")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false });

  if (mode) {
    query = query.eq("mode", mode);
  }

  const { data, error } = await query;
  if (error) {
    console.warn("[conversations] load error:", error);
    return [];
  }
  return data || [];
}

export async function loadMessages(
  supabase: SupabaseClient,
  conversationId: string
): Promise<DbMessage[]> {
  const { data, error } = await supabase
    .from("messages")
    .select("*")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });

  if (error) {
    console.warn("[conversations] loadMessages error:", error);
    return [];
  }
  return data || [];
}

export async function deleteConversation(
  supabase: SupabaseClient,
  conversationId: string
): Promise<boolean> {
  const { error } = await supabase
    .from("conversations")
    .delete()
    .eq("id", conversationId);

  if (error) {
    console.warn("[conversations] delete error:", error);
    return false;
  }
  return true;
}

export async function updateConversationTitle(
  supabase: SupabaseClient,
  conversationId: string,
  title: string
): Promise<boolean> {
  const { error } = await supabase
    .from("conversations")
    .update({ title, updated_at: new Date().toISOString() })
    .eq("id", conversationId);

  if (error) {
    console.warn("[conversations] updateTitle error:", error);
    return false;
  }
  return true;
}

export async function touchConversation(
  supabase: SupabaseClient,
  conversationId: string
): Promise<void> {
  await supabase
    .from("conversations")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", conversationId);
}
