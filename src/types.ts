export interface WSIncomingMessage {
  type: "chat" | "permission_response" | "auth" | "init" | "new_session";
  content?: string;
  requestId?: string;
  allowed?: boolean;
  password?: string;
  deviceId?: string;
}

export interface WSOutgoingMessage {
  type: "chunk" | "done" | "error" | "status" | "permission_request" | "auth_required" | "auth_ok" | "auth_fail" | "session_restored";
  content?: string;
  requestId?: string;
  description?: string;
}
