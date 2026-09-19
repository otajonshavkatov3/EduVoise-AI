#!/bin/bash

# ===========================================
# Project Setup Script
# ===========================================
# This script renames the template to your project name
# Usage: ./scripts/setup.sh

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}"
echo "╔════════════════════════════════════════╗"
echo "║       Project Setup Script             ║"
echo "╚════════════════════════════════════════╝"
echo -e "${NC}"

# Get project name
read -p "Enter your project name (e.g., my-awesome-app): " PROJECT_NAME

if [ -z "$PROJECT_NAME" ]; then
    echo -e "${RED}Error: Project name cannot be empty${NC}"
    exit 1
fi

# Validate project name (lowercase, alphanumeric, hyphens only)
if ! [[ "$PROJECT_NAME" =~ ^[a-z][a-z0-9-]*$ ]]; then
    echo -e "${RED}Error: Project name must start with a letter and contain only lowercase letters, numbers, and hyphens${NC}"
    exit 1
fi

# Create variations of the name
PROJECT_NAME_SNAKE=$(echo "$PROJECT_NAME" | tr '-' '_')
PROJECT_NAME_PASCAL=$(echo "$PROJECT_NAME" | sed -r 's/(^|-)([a-z])/\U\2/g')
PROJECT_NAME_TITLE=$(echo "$PROJECT_NAME_PASCAL" | sed 's/\([A-Z]\)/ \1/g' | sed 's/^ //')

echo ""
echo -e "${YELLOW}Project name: ${GREEN}$PROJECT_NAME${NC}"
echo -e "${YELLOW}Package scope: ${GREEN}@$PROJECT_NAME${NC}"
echo -e "${YELLOW}Database name: ${GREEN}$PROJECT_NAME_SNAKE${NC}"
echo -e "${YELLOW}Display title: ${GREEN}$PROJECT_NAME_TITLE${NC}"
echo ""
read -p "Continue? (y/n): " CONFIRM

if [ "$CONFIRM" != "y" ]; then
    echo "Aborted."
    exit 0
fi

echo ""
echo -e "${BLUE}Updating files...${NC}"

# Root package.json
echo "  - package.json"
sed -i "s/\"name\": \"my-app\"/\"name\": \"$PROJECT_NAME\"/" package.json

# Shared package.json
echo "  - shared/package.json"
sed -i "s/@app\/shared/@$PROJECT_NAME\/shared/g" shared/package.json

# Frontend package.json
echo "  - apps/frontend/package.json"
sed -i "s/@app\/shared/@$PROJECT_NAME\/shared/g" apps/frontend/package.json

# Backend package.json
echo "  - apps/backend/package.json"
sed -i "s/@app\/shared/@$PROJECT_NAME\/shared/g" apps/backend/package.json

# Environment file
echo "  - .env.example"
sed -i "s/My App/$PROJECT_NAME_TITLE/g" .env.example
sed -i "s/myapp/$PROJECT_NAME_SNAKE/g" .env.example

# Docker compose
echo "  - docker-compose.yml"
sed -i "s/app-postgres/$PROJECT_NAME-postgres/g" docker-compose.yml
sed -i "s/app-redis/$PROJECT_NAME-redis/g" docker-compose.yml
sed -i "s/myapp/$PROJECT_NAME_SNAKE/g" docker-compose.yml

# Backend API
echo "  - apps/backend/src/lib/create-app.ts"
sed -i "s/My App API/$PROJECT_NAME_TITLE API/g" apps/backend/src/lib/create-app.ts

# Frontend HTML
echo "  - apps/frontend/index.html"
sed -i "s/<title>My App<\/title>/<title>$PROJECT_NAME_TITLE<\/title>/g" apps/frontend/index.html

# Frontend MainLayout
echo "  - apps/frontend/src/shared/components/layouts/MainLayout.tsx"
sed -i "s/\"My App\"/\"$PROJECT_NAME_TITLE\"/g" apps/frontend/src/shared/components/layouts/MainLayout.tsx

# Frontend LoginForm
echo "  - apps/frontend/src/modules/auth/components/LoginForm.tsx"
sed -i "s/My App/$PROJECT_NAME_TITLE/g" apps/frontend/src/modules/auth/components/LoginForm.tsx

echo ""
echo -e "${BLUE}Creating .env from .env.example...${NC}"
cp .env.example .env

echo ""
echo -e "${BLUE}Installing dependencies...${NC}"
bun install

echo ""
echo -e "${GREEN}╔════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║           Setup Complete!              ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════╝${NC}"
echo ""
echo -e "Next steps:"
echo -e "  1. Update ${YELLOW}.env${NC} with your actual credentials"
echo -e "  2. Start Docker: ${YELLOW}docker compose up -d${NC}"
echo -e "  3. Run migrations: ${YELLOW}bun run db:migrate${NC} (in apps/backend)"
echo -e "  4. Seed database: ${YELLOW}bun run db:seed${NC} (in apps/backend)"
echo -e "  5. Start dev server: ${YELLOW}bun run dev${NC}"
echo ""
