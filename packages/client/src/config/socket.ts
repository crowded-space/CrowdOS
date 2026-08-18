import { io } from "socket.io-client";

// Connect to Fastify Socket.io backend via Vite proxy (same origin)
export const socket = io({
  path: '/socket.io',
  autoConnect: true,
  withCredentials: true,
  transports: ["websocket", "polling"]
});
