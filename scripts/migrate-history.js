/**
 * migrate-history.js - Repara historiales con phases: {} vacío
 * 
 * Uso: node scripts/migrate-history.js [kanbanPath]
 */

const fs = require('fs');
const path = require('path');

const KANBAN_PATH = process.argv[2] || path.join(__dirname, '..', 'kanban');
const HISTORY_DIR = path.join(KANBAN_PATH, '.history');

console.log('🔧 Migración de historiales');
console.log('   Kanban path:', KANBAN_PATH);
console.log('');

if (!fs.existsSync(HISTORY_DIR)) {
  console.log('❌ No existe directorio de historial');
  process.exit(1);
}

// Buscar todos los archivos JSON de historial
const historyFiles = fs.readdirSync(HISTORY_DIR)
  .filter(f => f.endsWith('.json'));

console.log(`📂 Encontrados ${historyFiles.length} archivos de historial\n`);

let fixed = 0;
let alreadyOk = 0;

for (const file of historyFiles) {
  const filePath = path.join(HISTORY_DIR, file);
  const taskId = file.replace('.json', '');
  
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const history = JSON.parse(content);
    
    if (!Array.isArray(history)) {
      console.log(`⚠️  ${file}: No es un array, saltando`);
      continue;
    }
    
    let modified = false;
    const artifactsDir = path.join(HISTORY_DIR, taskId);
    const hasArtifacts = fs.existsSync(artifactsDir);
    
    // Obtener lista de artefactos si existen
    let artifacts = [];
    if (hasArtifacts) {
      artifacts = fs.readdirSync(artifactsDir)
        .filter(f => f.endsWith('.md'))
        .map(f => f.replace('.md', ''));
    }
    
    for (const entry of history) {
      // Si phases está vacío o no tiene las claves esperadas
      if (!entry.phases || Object.keys(entry.phases).length === 0 ||
          !entry.phases.plan || !('code' in entry.phases)) {
        
        // Reconstruir phases desde artefactos si existen
        const newPhases = {
          plan: { status: 'unknown', duration: 0, summary: '' },
          code: [],
          review: [],
          test: [],
          scope: { status: 'unknown', duration: 0, summary: '' },
        };
        
        // Si hay artefactos, usarlos para reconstruir
        if (artifacts.length > 0) {
          if (artifacts.includes('plan')) {
            newPhases.plan = { status: 'ok', duration: 0, summary: 'Reconstruido desde artefacto' };
          }
          
          // Buscar code-iterN
          const codeIters = artifacts.filter(a => a.startsWith('code-iter'));
          for (const c of codeIters) {
            const iter = parseInt(c.replace('code-iter', '')) || 1;
            newPhases.code.push({ iteration: iter, status: 'ok', duration: 0, summary: 'Reconstruido' });
          }
          
          // Buscar review-iterN
          const reviewIters = artifacts.filter(a => a.startsWith('review-iter'));
          for (const r of reviewIters) {
            const iter = parseInt(r.replace('review-iter', '')) || 1;
            newPhases.review.push({ iteration: iter, status: 'approved', duration: 0, summary: 'Reconstruido' });
          }
          
          // Buscar test-iterN
          const testIters = artifacts.filter(a => a.startsWith('test-iter'));
          for (const t of testIters) {
            const iter = parseInt(t.replace('test-iter', '')) || 1;
            newPhases.test.push({ iteration: iter, status: 'ok', duration: 0, summary: 'Reconstruido' });
          }
          
          if (artifacts.includes('scope')) {
            newPhases.scope = { status: 'ok', duration: 0, summary: 'Reconstruido desde artefacto' };
          }
        } else {
          // Sin artefactos - marcar como datos perdidos
          newPhases.plan = { status: 'lost', duration: 0, summary: 'Datos no disponibles' };
          newPhases.scope = { status: 'lost', duration: 0, summary: 'Datos no disponibles' };
        }
        
        entry.phases = newPhases;
        modified = true;
      }
    }
    
    if (modified) {
      // Crear backup
      fs.writeFileSync(filePath + '.bak', content, 'utf8');
      // Guardar versión reparada
      fs.writeFileSync(filePath, JSON.stringify(history, null, 2), 'utf8');
      console.log(`✅ ${file}: Reparado (backup: ${file}.bak)`);
      console.log(`   Artefactos encontrados: ${artifacts.join(', ') || 'ninguno'}`);
      fixed++;
    } else {
      console.log(`✓  ${file}: Ya OK`);
      alreadyOk++;
    }
    
  } catch (err) {
    console.log(`❌ ${file}: Error - ${err.message}`);
  }
}

console.log('');
console.log('═══════════════════════════════════════');
console.log(`📊 Resumen:`);
console.log(`   Reparados: ${fixed}`);
console.log(`   Ya OK: ${alreadyOk}`);
console.log(`   Total: ${historyFiles.length}`);
console.log('═══════════════════════════════════════');
