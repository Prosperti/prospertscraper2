import fs from 'fs';

let content = fs.readFileSync('src/data/german_districts.ts', 'utf8');

let lines = content.split('\n');
let currentState = '';
let newLines = [];

for (let i = 0; i < lines.length; i++) {
  let line = lines[i];
  
  let commentMatch = line.match(/^\s*\/\/\s*([A-Za-zäöüÄÖÜß \-]+)(?:\s*-.*)?$/);
  if (commentMatch && !line.includes('eslint') && !line.includes('tslint')) {
    currentState = commentMatch[1].trim();
    if (currentState.includes('(')) {
      currentState = currentState.split('(')[0].trim();
    }
  }
  
  if (line.includes('{ name:') && currentState) {
    line = line.replace('{ name:', `{ state: "${currentState}", name:`);
  }
  
  newLines.push(line);
}

for (let i = 0; i < newLines.length; i++) {
  if (newLines[i].includes('export interface District {')) {
    newLines.splice(i + 1, 0, '  state?: string;');
    break;
  }
}

fs.writeFileSync('src/data/german_districts.ts', newLines.join('\n'));
console.log('Done');
