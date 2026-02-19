#!/bin/bash
# setup.sh - Script de configuración inicial del sistema AI-Kanban

set -e

BLUE='\033[0;34m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo ""
echo -e "${BLUE}🤖 AI-Kanban Setup${NC}"
echo "================================"
echo ""

# Verificar Node.js
if ! command -v node &> /dev/null; then
  echo -e "${RED}❌ Node.js no encontrado. Instala Node.js >= 18${NC}"
  exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
  echo -e "${RED}❌ Node.js >= 18 requerido. Versión actual: $(node -v)${NC}"
  exit 1
fi

echo -e "${GREEN}✓ Node.js $(node -v)${NC}"

# Instalar dependencias
echo ""
echo "Instalando dependencias..."
npm install

echo -e "${GREEN}✓ Dependencias instaladas${NC}"

# Crear carpetas del kanban si no existen
echo ""
echo "Creando estructura de carpetas..."
mkdir -p kanban/{backlog,todo,in_progress,review,done}
echo -e "${GREEN}✓ Carpetas creadas${NC}"

# Hacer el CLI ejecutable
chmod +x src/cli/index.js
echo -e "${GREEN}✓ CLI configurado${NC}"

# Crear alias (opcional)
echo ""
echo -e "${YELLOW}Para usar el CLI globalmente, ejecuta:${NC}"
echo "  npm link"
echo ""
echo -e "${YELLOW}O usa directamente:${NC}"
echo "  node src/cli/index.js <comando>"
echo ""

# Verificar ANTHROPIC_API_KEY
if [ -z "$ANTHROPIC_API_KEY" ]; then
  echo -e "${YELLOW}⚠  ANTHROPIC_API_KEY no configurada${NC}"
  echo "  Para el motor IA, configura:"
  echo "  export ANTHROPIC_API_KEY=tu-clave"
  echo ""
else
  echo -e "${GREEN}✓ ANTHROPIC_API_KEY configurada${NC}"
fi

echo ""
echo -e "${GREEN}✅ Setup completado!${NC}"
echo ""
echo "Comandos disponibles:"
echo "  node src/cli/index.js create --title='Mi tarea' --type=feature"
echo "  node src/cli/index.js list"
echo "  node src/cli/index.js board"
echo "  node src/cli/index.js start"
echo ""
