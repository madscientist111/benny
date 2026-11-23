---
title: An open-source Devin alternative that lives in GitHub issues
description: Benny is a self-hosted, open-source Devin alternative on Cloudflare Workers and Durable Objects that lives in GitHub issues and PRs.
slug: open-source-devin-alternative-github-issues
---

Benny is a persistent, self-hosted AI software engineer for GitHub, and an open-source alternative to Devin, Capy, and Factory's Droids. I run it on my laptop or on my own Cloudflare account with Workers, Durable Objects, and containers. It is one person's experiment rather than a hosted product, built for my own work and shared as a reference.

When a dependency cache misses on every cold start, I mention Benny in an issue to find out why and write the fix as requirements. It replies with what it found and what it proposes, and we go back and forth until the requirements are right. Then I tell it to start, and it commits the fix and opens a pull request.

## Why I did not want another dashboard

An engineering agent does not need another web app. Engineers already live in GitHub with the backlog, discussions, and review history next to the code. When a reply ends on a question or a PR is ready for review, Benny adds `[INPUT_REQUIRED]` to the issue title so one search shows every thread waiting for me, and my next comment clears the mark.

## What always on means

Every issue gets its own persistent agent on Durable Objects that keeps its context and branch between messages. Once mentioned, Benny follows the thread without answering every "thanks", and can run on a recurring schedule like a weekday 9am IST digest of what merged and what is stuck. Always on does not mean always running: the agent sleeps for free and wakes on a comment or due schedule.

## What it will not do

Benny opens pull requests, and that is it. It has no tool to merge, approve, or close a PR, never changes workflows, and hides secrets and keys. Every GitHub write requires a mention from a repo member with write access, so the agent writes code and runs tests while a human controls merges. Outsider text can still steer a member-started run, so I run it only on repos where I know who comments.

## How it compares

Devin, Capy, and Factory's Droids are the established products here, and Benny does not try to match them feature for feature. Those run as hosted products across their own web apps, Slack, terminals, or IDEs. Benny is a small, open-source project that lives in GitHub issues and PRs, runs on your own machine or Cloudflare account, and stays small enough to read.

## Run it yourself

There is no hosted Benny to buy: you run it locally with `pnpm dev` and a webhook tunnel, or on your Cloudflare account with Workers, Durable Objects, and containers running Claude Code so your laptop can be off. GitHub is the focus first, followed by Slack, other integrations, and eventually Benny's own interface. The repo is at https://github.com/madscientist111/benny under the MIT licence. Read it, copy what you like, or fork it.
