<p align="center">
  <img src="logo.png" alt="DeepConverge" width="500" />
</p>

<p align="center">
  <strong>Multi-Agent AI Debate Platform</strong><br/>
  Smarter answers through structured adversarial reasoning.
</p>

<p align="center">
  <a href="https://deepconverge.ai">deepconverge.ai</a>
</p>

---

## What is DeepConverge?

DeepConverge is an AI platform where multiple agents debate each other in real time to produce higher-quality answers. Instead of relying on a single model's response, DeepConverge orchestrates three specialized agents that argue, challenge, and synthesize — delivering answers that are more accurate, more nuanced, and more trustworthy.

## How It Works

```
                    ┌─────────────┐
                    │  Your Query │
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │   ADVOCATE  │  Argues the strongest case
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │    CRITIC   │  Challenges flaws & assumptions
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │    JUDGE    │  Synthesizes the final verdict
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │   Answer    │
                    └─────────────┘
```

Each agent sees the full history of the debate. The **Advocate** builds the strongest possible argument. The **Critic** stress-tests it for errors, bias, and logical gaps. The **Judge** weighs both sides and delivers a final, well-reasoned answer.

This adversarial structure is inspired by the **Multi-Agent Debate (MAD)** framework, which has been shown to outperform single-model reasoning and self-reflection on complex tasks.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Frontend** | Next.js 16 (App Router) + React + Tailwind CSS |
| **AI Model** | NVIDIA Nemotron via OpenRouter |
| **Auth** | Supabase (Google OAuth + PKCE) |
| **Streaming** | Server-Sent Events (SSE) for real-time debate |
| **Deployment** | Vercel |

## Getting Started

```bash
# Clone the repository
git clone https://github.com/Hanbrar/DeepConverge.git
cd DeepConverge

# Install dependencies
npm install

# Set up environment variables
cp .env.example .env.local
# Add your OpenRouter API key to .env.local

# Start development server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to start debating.

## Research

DeepConverge is built on the principles of multi-agent debate for improving LLM reasoning:

> Tian Liang, Zhiwei He, Wenxiang Jiao, Xing Wang, Yan Wang, Rui Wang, Yujiu Yang, Shuming Shi, Zhaopeng Tu. **"Encouraging Divergent Thinking in Large Language Models through Multi-Agent Debate."** *arXiv:2305.19118*, 2024.
>
> The paper proposes the MAD framework to address the Degeneration-of-Thought problem in LLM self-reflection, demonstrating that structured debate between multiple agents produces divergent chain-of-thoughts and significantly outperforms single-model approaches.

Read the full paper: [`2305.19118v4.pdf`](2305.19118v4.pdf) | [arXiv](https://arxiv.org/abs/2305.19118)

---

<p align="center">
  <img src="Nvidia_logo.png" alt="NVIDIA" width="120" />
</p>

<p align="center">
  Built for <strong>NVIDIA GTC 2026</strong> Golden Ticket Contest
</p>

---

<p align="center">
  Made by <strong>Hanryck Brar</strong> &mdash; <a href="https://x.com/ItsHB17">@ItsHB17</a>
</p>

<p align="center">
  <a href="LICENSE">MIT License</a> &copy; 2026
</p>
