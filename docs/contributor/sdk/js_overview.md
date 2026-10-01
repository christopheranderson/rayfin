# JavaScript Overview

- uses npm workspaces

## Common lifecycle scripts

```bash
# install dependencies
rush update
# Build and test all
rush build
rush test

# Run specific test
rush test --only @microsoft/rayfin-cli
```

## Creating new package

```bash
mkdir <NAME_GOES_HERE>
cd <NAME_GOES_HERE>

# Scoped:
npm init  --scope=@microsoft -y

# Non-scoped:
npm init -y

# copy the config from other projects
cp ../core/tsconfig.json tsconfig.json
cp ../core/vitest.config.ts vitest.config.ts
cp -r ../core/config config
mkdir src
echo "console.log('hello world')" > src/index.ts

```

Afterwards, update the rush.json projects section ([reference](https://rushjs.io/pages/maintainer/add_to_repo/#step-7-adding-more-projects)) to include your new project

## Run an npm script

```bash
# Run scripts in every package
rush build

# Run scripts in all sdk packages
rush test --to tag:sdk

# Run scripts in my local package
rushx test
# OR
rush test --only .

# Run scripts in a specific package
rush test --only @microsoft/rayfin-data
```
