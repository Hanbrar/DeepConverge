# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Kangaroo** - A multi-agent AI debate platform for the NVIDIA GTC 2026 Golden Ticket Contest.

Users ask questions and watch 3 AI agents (Advocate, Critic, Judge) debate in real-time to produce smarter answers.

## Tech Stack

- **Frontend:** Next.js 14 (App Router) + React + Tailwind CSS
- **AI Model:** `nvidia/llama-3.1-nemotron-70b-instruct:free` via OpenRouter
- **Streaming:** Server-Sent Events (SSE) for real-time debate

## Commands

```bash
cd kangaroo
npm run dev      # Start development server (localhost:3000)
npm run build    # Production build
npm run lint     # Run ESLint
```

## Project Structure

```
kangaroo/
├── app/
│   ├── page.tsx              # Landing page with debate UI
│   ├── layout.tsx            # Root layout with Inter font
│   ├── globals.css           # Tailwind + custom styles (pink gradient, glassmorphism)
│   └── api/debate/route.ts   # Streaming debate endpoint
├── components/
│   ├── Header.tsx            # Logo + avatar
│   ├── AgentFlow.tsx         # 3 agent cards with flow lines
│   ├── DebateInput.tsx       # Pill-shaped input bar
│   ├── TabSelector.tsx       # General/Debate/Productivity tabs
│   ├── DebateStream.tsx      # Real-time message container
│   ├── AgentMessage.tsx      # Individual agent message with markdown
│   └── ReasoningBlock.tsx    # Collapsible reasoning display
├── lib/
│   ├── types.ts              # TypeScript types
│   ├── agents.ts             # Agent definitions and prompts
│   └── openrouter.ts         # OpenRouter API client
└── .env.example              # Environment variables template
```

## Agent Debate Flow

```
User Question
     ↓
ADVOCATE  → argues positive side
     ↓
CRITIC    → challenges and finds flaws (sees Advocate's argument)
     ↓
JUDGE     → synthesizes verdict (sees both arguments)
```

## Environment Setup

Copy `.env.example` to `.env.local` and add your OpenRouter API key:
```
OPENROUTER_API_KEY=sk-or-v1-your-key
```

## Design System

- Background: Pink-lavender gradient (#f5f0f5 → #faf8f7)
- Accent: Coral (#f08a7a)
- Cards: White with glassmorphism
- Typography: Inter font
