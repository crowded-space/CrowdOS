# Community Agent

Monorepo bootstrap for the Community Agent project.

## Stack Decisions

- Backend: Fastify
- Frontend: Vite + React + TypeScript
- Styling: Tailwind CSS v4

## Local Setup

```bash
npm install
npm run dev
```

This starts:

- Server: `http://localhost:3001`
- Client: `http://localhost:5173`

## Verification

- Health route: `GET http://localhost:3001/health`
- Client should load the empty shell page in the browser