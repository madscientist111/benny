---
title: "I don't want to learn another agentic UI"
description: "Everyone is building a new UI for AI agents. I run my software factory on GitHub instead, with an open-source coding agent that lives in my issues."
published: 2026-11-26
draft: false
image: "/blog/i-dont-want-another-agentic-ui.webp"
imageAlt: "Benny the beaver running a small factory line: blank cards go in, ticked cards come out, and a hand gives a thumbs up"
shareImage: "/blog/i-dont-want-another-agentic-ui-share.jpg"
---

I don't want to learn another "agentic" UI, dawg. Can't we stick to what we have?

A lot of people I know in tech are building their own UI to use agents better. Some turned it into a startup. The rest built it to get a tailor-fit version that works exactly the way they like.

Why is everyone building one? Here's what I think.

## The tools we already use have the context

We already live in Jira, Slack and GitHub. They hold the context that makes AI useful: the issue, the discussion, the code, who asked for what and why.

And to be fair, the big ones have built agents into them. On GitHub you can [assign an issue to Copilot's coding agent](https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-coding-agent) and it opens a pull request. Atlassian has [Rovo Dev in Jira](https://www.atlassian.com/blog/company-news/rovo-dev-in-jira), which goes from a work item to a pull request. Devin works from Slack.

So "where the agent lives" is mostly solved. What I care about is who runs it. These are hosted products: they mostly run on the vendor's infrastructure, and you pay on the vendor's plan, with its quotas and its usage billing. That's fine for a lot of teams. I wanted something I own.

## So I run my own factory on GitHub

For code, GitHub already is a software factory. Issues go in, the thread is where the team argues, pull requests come out, and a person decides what ships. It just needed someone on the line doing the work.

That's Benny, an always-on coding agent that lives in my GitHub issues. I mention it in an issue, it reads the code and proposes what to build, and once I say go, it works on its own branch and opens a pull request. It can't merge, approve or close a pull request, so a person always signs off.

Each issue I mention it in gets its own agent. It keeps that thread's context and its work branch, and sleeps between comments, so it picks up where it left off.

## It can be cheap, because it runs on your stuff

Every option here has a base plan with limits and usage billing on top, including mine. The difference is that with Benny you pick the engine and the plan, and the infrastructure is your own account.

Benny gives you two engines for the model's work:

- **Claude Code**, with your own Claude account. This is the one I use for my own work, because it's the model I want for hard tasks. It costs whatever your Claude plan costs. If you use a subscription, check Anthropic's terms for how you use it.
- **OpenCode Go**, through the pi harness. [OpenCode Go](https://opencode.ai/docs/go/) is a $10 monthly plan for models that coding agents can use. This is the cheap route.

The cheapest setup is OpenCode Go plus Cloudflare's $5 Workers Paid plan, which Benny needs for Containers. That's about $15 a month. Exa gives you free searches every month.

There's no per-seat fee. But a teammate's requests come out of the same plan limits and the same usage bills, so more people means more usage. Whether a team may share one person's subscription is a question for that plan's terms.

The trade-off is that you run it yourself. There's no hosted Benny. You set up a GitHub App, your keys, and run it on your laptop or a home server with a tunnel, or host it on your Cloudflare account. The README walks through both.

## Honestly, it started as a learning project

Honestly, this started as a learning project, lol. Halfway through I realised it actually works, boss. So here it is.

It's still an experiment that runs my own work. I only use it on repos where I know who comments, because text from outsiders can still steer a run. That's in the README too.

Benny is MIT licensed. [Read the code on GitHub](https://github.com/madscientist111/benny), copy what you like, or fork it and run your own factory where your team already works.
