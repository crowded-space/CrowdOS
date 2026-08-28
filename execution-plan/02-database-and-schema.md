# 02 Database And Schema

## Goal
Make persistence work before feature logic grows.

## Tasks
- [ ] Add PostgreSQL connection config.
- [ ] Add Drizzle ORM setup.
- [ ] Add schema push flow after `DATABASE_URL` is set.
- [ ] Enable `pgvector` extension.
- [ ] Create base tables for agents, categories, channels, messages.
- [ ] Create provider profile tables.
- [ ] Create spawn request and task file tables.
- [ ] Create token usage and summary tables.
- [ ] Add migration or push command.
- [ ] Seed minimal starter data: `#general`.

## Small checks
- [ ] Connect to empty database.
- [ ] Push schema successfully.
- [ ] Read and write one agent row.
- [ ] Read and write one message row.

## Done when
- Local database bootstraps from config.
- Core tables exist.
- Server can query all core tables without manual SQL edits.
