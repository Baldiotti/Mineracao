# Scripts

Esta pasta contém os scripts Node.js para mineração e análise de dados.

## Estrutura

- Coloque aqui seus scripts `.js` para diferentes tarefas de mineração
- Use o arquivo `.env` na raiz do projeto para configurações sensíveis
- Os resultados devem ser salvos na pasta `output/`

## Exemplo de uso do .env

```javascript
require('dotenv').config();
const token = process.env.GITHUB_TOKEN;
```
