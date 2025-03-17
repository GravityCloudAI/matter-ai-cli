# Matter AI CLI

A command-line tool that helps you generate AI-powered summaries to understand changes quickly.

This CLI is an official tool from [Matter AI](https://matterai.dev) to help you generate summaries for your PRs.

## Installation

```bash
npm install -g matter-ai-cli
```

## Usage

1. Open the repository in the terminal with `.git` directory.
2. Create a new Classic Personal Access Token with `pull-requests` and `repo` scopes.
3. Run the command `matter`
4. Enter your PAT when prompted, this will get saved in you `~/.gitconfig` file.
5. Select the PR you want to summarize.
6. Enter your Open AI API Key when prompted. This can automatically be picked from `OPENAI_API_KEY` environment variable.
6. Enjoy the summary!
