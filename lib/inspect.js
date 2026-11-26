import fs from 'node:fs';
import path from 'node:path';

export function inspect(root, scope = '.') {
  const dir = path.resolve(root, scope);
  const dirs = [...new Set([dir, root])];
  const files = [];
  for (const base of dirs)
    for (const name of fs.readdirSync(base)) {
      if (
        /^(eslint\.config\.[cm]?[jt]s|\.eslintrc(?:\..+)?|tsconfig(?:\..+)?\.json|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|pnpm-workspace\.yaml)$/.test(
          name,
        )
      )
        files.push(path.relative(root, path.join(base, name)));
    }
  const packages = dirs.flatMap((base) => {
    const file = path.join(base, 'package.json');
    if (!fs.existsSync(file)) return [];
    const p = JSON.parse(fs.readFileSync(file, 'utf8'));
    return [
      {
        file: path.relative(root, file),
        manager: p.packageManager,
        workspaces: p.workspaces,
        eslintConfig: Boolean(p.eslintConfig),
        scripts: Object.keys(p.scripts ?? {}).filter((k) =>
          /lint|check|test|build/.test(k),
        ),
      },
    ];
  });
  const ci = ['.gitlab-ci.yml', 'Jenkinsfile', 'azure-pipelines.yml'].filter(
    (f) => fs.existsSync(path.join(root, f)),
  );
  const workflows = path.join(root, '.github/workflows');
  if (fs.existsSync(workflows))
    ci.push(
      ...fs
        .readdirSync(workflows)
        .filter((f) => /\.ya?ml$/.test(f))
        .map((f) => '.github/workflows/' + f),
    );
  return { files, packages, ci };
}
