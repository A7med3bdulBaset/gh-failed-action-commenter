import * as gh from "@actions/github";
import * as core from "@actions/core";

async function run() {
	console.log("Hello World!");

	const fixesStr =
		core.getInput("FIXES", { required: false, trimWhitespace: true }) || "{}";
	let packageManager = core.getInput("PACKAGE_MANAGER", {
		required: false,
		trimWhitespace: true,
	});
	const autoFix =
		core.getInput("AUTO_FIX", { required: false, trimWhitespace: true }) ||
		"{}";

	let fixes: Record<string, string>;
	try {
		fixes = JSON.parse(fixesStr);
	} catch (e) {
		core.setFailed(`Error parsing FIXES (${fixesStr}) as JSON: ${e}`);
		return;
	}

	if (!process.env.GITHUB_TOKEN) {
		core.setFailed("No GITHUB_TOKEN found in environment");
		return;
	}
	const octokit = gh.getOctokit(process.env.GITHUB_TOKEN);

	if (!packageManager) {
		const [lockfile] = await Promise.allSettled([
			octokit.rest.repos.getContent({
				repo: gh.context.repo.repo,
				owner: gh.context.repo.owner,
				path: "package-lock.json",
			}),
			octokit.rest.repos.getContent({
				repo: gh.context.repo.repo,
				owner: gh.context.repo.owner,
				path: "pnpm-lock.yaml",
			}),
			octokit.rest.repos.getContent({
				repo: gh.context.repo.repo,
				owner: gh.context.repo.owner,
				path: "yarn.lock",
			}),
			octokit.rest.repos.getContent({
				repo: gh.context.repo.repo,
				owner: gh.context.repo.owner,
				path: "bun.lock",
			}),
		]).then((res) => res.filter((r) => r.status === "fulfilled"));
		console.log("lockfile", lockfile);

		const lockfileName =
			lockfile?.status === "fulfilled" && "name" in lockfile.value.data
				? lockfile.value.data.name
				: "package-lock.json";
		packageManager = {
			"package-lock.json": "npm",
			"pnpm-lock.yaml": "pnpm",
			"yarn.lock": "yarn",
			"bun.lock": "bun",
		}[lockfileName]!;

		console.log("Detected package manager:", packageManager);
	}

	const runScript = packageManager === "npm" ? "npm run" : packageManager;

	const jobs = await octokit.rest.actions.listJobsForWorkflowRun({
		repo: gh.context.repo.repo,
		owner: gh.context.repo.owner,
		run_id: gh.context.runId,
	});

	let shouldComment = false;
	let commentBody = `Hello @${gh.context.actor} and thank you for the pull request,\n\n`;
	commentBody += "The following jobs failed and must be fixed:\n\n";

	for (const job of jobs.data.jobs) {
		const { name, conclusion } = job;
		const fix = fixes[name];

		if (conclusion === "failure") {
			shouldComment = true;
			commentBody += `- [ ] ${name}`;
			if (fix) {
				commentBody += `. This check can be fixed by running <code>${
					runScript + " " + fix
				}</code>`;
			}
			commentBody += "\n";
		}
	}

	if (!shouldComment) {
		console.log("No jobs failed, skipping comment");
		return;
	}

	let commentId: number | undefined = undefined;

	if (!commentId) {
		const comment = await octokit.rest.issues.createComment({
			repo: gh.context.repo.repo,
			owner: gh.context.repo.owner,
			issue_number: gh.context.issue.number,
			body: commentBody,
		});

		commentId = comment.data.id;
	} else {
		await octokit.rest.issues.updateComment({
			repo: gh.context.repo.repo,
			owner: gh.context.repo.owner,
			comment_id: commentId,
			body: commentBody,
		});
	}

	if (shouldComment) {
		await octokit.rest.issues.addLabels({
			repo: gh.context.repo.repo,
			owner: gh.context.repo.owner,
			issue_number: gh.context.issue.number,
			labels: ["CI: Failed"],
		});

		await octokit.rest.issues.removeLabel({
			repo: gh.context.repo.repo,
			owner: gh.context.repo.owner,
			issue_number: gh.context.issue.number,
			name: "CI: Passed",
		});
	} else {
		await octokit.rest.issues.addLabels({
			repo: gh.context.repo.repo,
			owner: gh.context.repo.owner,
			issue_number: gh.context.issue.number,
			labels: ["CI: Passed"],
		});

		await octokit.rest.issues.removeLabel({
			repo: gh.context.repo.repo,
			owner: gh.context.repo.owner,
			issue_number: gh.context.issue.number,
			name: "CI: Failed",
		});
	}

	core.setOutput("comment_id", commentId);

	if (autoFix) {
		const fixes: Record<string, string> = JSON.parse(autoFix);

		for (const job of jobs.data.jobs) {
			const { name, conclusion } = job;
			const workflowFileName = fixes[name];

			if (conclusion === "failure" && workflowFileName) {
				await octokit.rest.actions.createWorkflowDispatch({
					repo: gh.context.repo.repo,
					owner: gh.context.repo.owner,
					ref: gh.context.ref,
					workflow_id: workflowFileName,
				});
			}
		}
	}
}

run();
