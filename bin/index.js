#!/usr/bin/env node
import chalk from "chalk";
import { execa } from "execa";
import inquirer from "inquirer";
import fetch from "node-fetch";
import { marked } from 'marked';
import TerminalRenderer from 'marked-terminal';

// Handle exit signals gracefully
process.on('SIGINT', () => {
  console.log(chalk.yellow('\nExiting...'));
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log(chalk.yellow('\nExiting...'));
  process.exit(0);
});

// Get GitHub token from git config or prompt for manual entry
async function getGitHubToken() {
  try {
    // Try to get token from git config
    const { stdout } = await execa('git', ['config', '--get', 'github.token']);
    return stdout.trim();
  } catch (error) {
    try {
      const { stdout: hubConfig } = await execa('git', ['config', '--get', 'hub.oauthtoken']);
      return hubConfig.trim();
    } catch (error) {
      // Ask if user wants to enter a token
      const { shouldEnterToken } = await inquirer.prompt([
        {
          type: "confirm",
          name: "shouldEnterToken",
          message: "No GitHub token found. Would you like to enter a personal access token?",
          default: true
        }
      ]);

      if (shouldEnterToken) {
        console.log(chalk.blue("\nTo create a personal access token:"));
        console.log(chalk.blue("1. Go to https://github.com/settings/tokens"));
        console.log(chalk.blue("2. Click 'Generate new token'"));
        console.log(chalk.blue("3. Give it a name (e.g., 'PR Checkout CLI')"));
        console.log(chalk.blue("4. Select the 'repo' scope"));
        console.log(chalk.blue("5. Click 'Generate token'"));
        console.log(chalk.blue("6. Copy the token and paste it below\n"));

        const { token } = await inquirer.prompt([
          {
            type: "password",
            name: "token",
            message: "Enter your GitHub personal access token:",
            validate: input => input.length > 0 ? true : "Token cannot be empty"
          }
        ]);

        // Save the token to git config
        try {
          await execa('git', ['config', '--global', 'github.token', token]);
          console.log(chalk.green("Token saved to git config."));
        } catch (saveError) {
          console.warn(chalk.yellow("Could not save token to git config. It will only be used for this session."));
        }

        return token;
      } else {
        console.warn(chalk.yellow("Proceeding without authentication."));
        console.warn(chalk.yellow("For private repositories, set your token with:"));
        console.warn(chalk.yellow("  git config --global github.token YOUR_TOKEN"));
        return null;
      }
    }
  }
}

// Fetch PRs using raw git commands and GitHub API
async function getPRs() {
  try {
    // Get the remote URL to extract owner and repo
    const { stdout: remoteUrl } = await execa("git", ["config", "--get", "remote.origin.url"]);

    // Extract owner and repo from the remote URL (handles both HTTPS and SSH formats)
    let match = remoteUrl.match(/github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?$/);
    if (!match) {
      console.error(chalk.red("Could not determine GitHub repository from remote URL."));
      process.exit(1);
    }

    const [, owner, repo] = match;

    // Try to get token from git config
    const token = await getGitHubToken();

    // Fetch PR details from GitHub API first
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/pulls?state=open`;

    const headers = {
      "User-Agent": "PR-Checkout-CLI"
    };

    // Add authentication if we have a token
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    const response = await fetch(apiUrl, { headers });

    let allPRs = [];

    if (!response.ok) {
      console.error(chalk.red(`GitHub API error: ${response.status} ${response.statusText}`));
      if (response.status === 401 || response.status === 403) {
        console.error(chalk.red("Authentication failed."));
      }
    } else {
      allPRs = await response.json();
    }

    // Sort PRs by creation date (newest first)
    allPRs.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    // If we have PRs from the API, return them directly
    if (allPRs.length > 0) {
      return allPRs.map(pr => ({
        number: pr.number.toString(),
        title: pr.title,
        author: pr.user?.login || "unknown",
        createdAt: pr.created_at
      }));
    }

    // Fallback to git ls-remote if API returned no PRs or failed
    const { stdout } = await execa("git", ["ls-remote", "--refs", "origin", "pull/*/head"]);
    const prNumbers = stdout
      .split("\n")
      .filter(Boolean)
      .map(line => {
        const match = line.match(/refs\/pull\/(\d+)\/head/);
        return match ? match[1] : null;
      })
      .filter(Boolean);

    if (prNumbers.length === 0) {
      console.log(chalk.yellow("No open PRs found."));
      process.exit(0);
    }

    // If we have API data, match it with PR numbers
    console.log(allPRs);
    if (allPRs.length > 0) {
      const prList = prNumbers.map(number => {
        const prDetails = allPRs.find(pr => pr.number.toString() === number);

        console.log(prDetails);

        return prDetails ? {
          number,
          title: prDetails.title,
          author: prDetails.user?.login || "unknown",
          createdAt: prDetails.created_at
        } : {
          number,
          title: "Unknown title",
          author: "unknown",
          createdAt: "unknown"
        };
      });

      // Sort PRs by creation date (newest first)
      prList.sort((a, b) => {
        if (a.createdAt === "unknown" || b.createdAt === "unknown") return 0;
        return new Date(b.createdAt) - new Date(a.createdAt);
      });

      return prList;
    } else {
      // If no API data, just return PR numbers
      return prNumbers.map(number => ({
        number,
        title: "Title not available",
        author: "unknown",
        createdAt: "unknown"
      }));
    }
  } catch (error) {
    console.error(chalk.red(`Error fetching PRs: ${error.message}`));
    console.error(chalk.yellow("Falling back to PR numbers only."));

    try {
      // Fallback to just PR numbers if everything else fails
      const { stdout } = await execa("git", ["ls-remote", "--refs", "origin", "pull/*/head"]);
      const prNumbers = stdout
        .split("\n")
        .filter(Boolean)
        .map(line => {
          const match = line.match(/refs\/pull\/(\d+)\/head/);
          return match ? {
            number: match[1],
            title: "Title not available",
            author: "unknown",
            createdAt: "unknown"
          } : null;
        })
        .filter(Boolean);

      return prNumbers;
    } catch (gitError) {
      console.error(chalk.red(`Failed to get PRs: ${gitError.message}`));
      process.exit(1);
    }
  }
}

async function getFilesChangedInPR(owner, repo, prNumber, token) {
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/files`;

  const headers = {
    "User-Agent": "PR-Checkout-CLI"
  };

  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  try {
    const response = await fetch(apiUrl, { headers });

    if (!response.ok) {
      console.error(chalk.yellow(`Could not fetch files for PR #${prNumber}: ${response.status} ${response.statusText}`));
      return [];
    }

    const files = await response.json();
    return files.map(file => ({
      filename: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes
    }));
  } catch (error) {
    console.error(chalk.yellow(`Error fetching files for PR #${prNumber}: ${error.message}`));
    return [];
  }
}

// CLI main function
async function main() {
  const prs = await getPRs();

  const { selectedPR } = await inquirer.prompt([
    {
      type: "list",
      name: "selectedPR",
      message: chalk.cyan("Select a PR:"),
      choices: prs.map(pr => {
        const displayTitle = pr.title === "Title not available"
          ? `PR #${pr.number}`
          : `PR #${pr.number}: ${pr.title} (by @${pr.author})`;
        return { name: displayTitle, value: pr.number };
      })
    }
  ]);

  console.log(chalk.green(`\nSelected PR: #${selectedPR}`));
  console.log(chalk.blue(`\nFetching PR details and changed files...`));

  const { stdout: remoteUrl } = await execa("git", ["config", "--get", "remote.origin.url"]);
  let match = remoteUrl.match(/github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?$/);

  if (!match) {
    console.error(chalk.red("Could not determine GitHub repository from remote URL."));
    process.exit(1);
  }

  const [, owner, repo] = match;
  const token = await getGitHubToken();

  // Fetch files changed in the PR
  const filesChanged = await getFilesChangedInPR(owner, repo, selectedPR, token);

  // Find the selected PR data and add files information
  const selectedPRData = prs.find(pr => pr.number === selectedPR);
  selectedPRData.filesChanged = filesChanged;
  selectedPRData.totalFilesChanged = filesChanged.length;

  // Prompt user to select the type of AI content
  const { contentType } = await inquirer.prompt([
    {
      type: "list",
      name: "contentType",
      message: chalk.cyan("What would you like to generate?"),
      choices: [
        { name: "AI Summary", value: "summary" },
        { name: "AI Code Review", value: "codeReview" },
        { name: "AI Explanation", value: "explanation" }
      ]
    }
  ]);

  // Handle based on selected content type
  if (contentType === "codeReview" || contentType === "explanation") {
    console.log(chalk.green("\nOnly Available in Hosted or Enterprise version. Get started here: https://matterai.dev"));
    process.exit(0);
  }

  // Continue with existing summary code for "summary" option
  const systemPrompt = `You are a senior software engineer whos job is to generate summary for github pull request`

  const userPrompt = `This is the PR Data in JSON format: ${JSON.stringify(selectedPRData)}. Return the generated Summary under the following headings PR Title, 🔄 What Changed, 🔍 Impact of the Change, 📁 Total Files Changed, 🧪 Test Added(explain each test in detail), 🔒Security Vulnerabilities.`

  // Get OpenAI API key from environment or prompt user
  let openaiApiKey = process.env.OPENAI_API_KEY;

  if (!openaiApiKey) {
    console.log(chalk.yellow("\nNo OpenAI API key found in environment variables."));

    const { shouldEnterKey } = await inquirer.prompt([
      {
        type: "confirm",
        name: "shouldEnterKey",
        message: "Would you like to enter an OpenAI API key?",
        default: true
      }
    ]);

    if (shouldEnterKey) {
      console.log(chalk.blue("\nTo get an OpenAI API key:"));
      console.log(chalk.blue("1. Go to https://platform.openai.com/api-keys"));
      console.log(chalk.blue("2. Sign in or create an account"));
      console.log(chalk.blue("3. Click 'Create new secret key'"));
      console.log(chalk.blue("4. Copy the key and paste it below\n"));

      const { apiKey } = await inquirer.prompt([
        {
          type: "password",
          name: "apiKey",
          message: "Enter your OpenAI API key:",
          validate: input => input.length > 0 ? true : "API key cannot be empty"
        }
      ]);

      openaiApiKey = apiKey;

      console.log(chalk.yellow("\nTip: To avoid entering the key each time, set it as an environment variable:"));
      console.log(chalk.yellow("  export OPENAI_API_KEY=your_api_key"));
    } else {
      console.error(chalk.red("Cannot generate AI summary without an OpenAI API key."));
      process.exit(1);
    }
  }

  // make API call to openAI
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${openaiApiKey}`
    },
    body: JSON.stringify({
      model: "gpt-4o-mini-2024-07-18",
      messages: [
        {
          role: "system",
          content: systemPrompt
        },
        {
          role: "user",
          content: userPrompt
        }
      ],
      temperature: 0.6,
      top_p: 1,
      max_tokens: 4096
    })
  });

  const data = await response.json();

  if (data.error) {
    console.error(chalk.red(`OpenAI API error: ${data.error.message}`));
    process.exit(1);
  }

  // Configure marked to use the terminal renderer
  marked.setOptions({
    renderer: new TerminalRenderer({
      // Customize the terminal renderer options if needed
      code: chalk.yellow,
      blockquote: chalk.gray.italic,
      table: chalk.white,
      listitem: chalk.green
    })
  });

  // Render the markdown content
  console.log("\n" + chalk.bold.underline("AI-Generated PR Summary:") + "\n\n");
  console.log(marked(data.choices[0].message.content));

}

main().catch(error => {
  if (error.name === 'ExitPromptError') {
    console.log(chalk.yellow('\nExiting...'));
    process.exit(0);
  } else {
    console.error(chalk.red(`Error: ${error.message}`));
    process.exit(1);
  }
});
