# Eixo Web

Landing page em português para oficinas, com formulário próprio e integração ao Evo CRM por uma Netlify Function. HTML, CSS e módulos JavaScript nativos; sem dependências npm para os testes.

## Estado atual

- Prévia ativa: https://bright-melomakarona-0510ff.netlify.app/
- Implantação de referência: `6ac0046e1b9c577017b9f41b`
- Recebimento no CRM confirmado pelo responsável: **Vendas EixoWeb → Novo Lead**
- `noindex, nofollow` permanece no HTML e nos cabeçalhos; `robots.txt` bloqueia indexação
- O domínio próprio continua pendente por vínculo com outra equipe da Netlify; este repositório não altera domínio, DNS ou a implantação existente

## Estrutura

- `site/`: página, estilos, imagens, formulário, validação compartilhada e adaptador de envio
- `netlify/functions/eixo-lead.mjs`: integração autenticada executada somente no servidor
- `netlify.toml`: publicação de `site/`, diretório das funções e execução dos testes no build
- `qa/*.test.mjs`: testes unitários offline com fixtures sintéticas
- `qa/static-inline-check.py`: verificações estáticas da página e das proteções atuais
- `.env.example`: nomes das variáveis, sem credenciais

## Executar e validar localmente

Requisitos: Node.js 22 ou superior e Python 3. Não é necessário executar `npm install`.

```sh
npm run check
npm run preview
```

Abra http://127.0.0.1:4173. A prévia local serve apenas os arquivos estáticos; não executa a função e não é um ambiente de envio ao CRM. Os módulos ES devem ser abertos por HTTP, não por `file://`.

Os testes usam respostas isoladas em memória, sem chamadas ao CRM. As verificações estáticas não comprovam renderização, acessibilidade visual, entrega de leads ou aplicação dos limites pela plataforma.

## Integração e configuração

O navegador envia apenas os quatro campos do formulário para `POST /api/eixo-lead`, na mesma origem. A função valida os dados novamente, resolve os nomes exatos do funil e da etapa e chama a API autenticada do Evo CRM. Nenhum token vai para o navegador.

A integração da prévia já está configurada e ativa. Para um novo ambiente autorizado, configure as variáveis no servidor:

- `EVO_API_ACCESS_TOKEN`: segredo informado diretamente pelo responsável nas configurações protegidas da Netlify; precisa das permissões de leitura dos funis e criação de leads
- `EVO_PIPELINE_NAME`: `Vendas EixoWeb`
- `EVO_STAGE_NAME`: `Novo Lead`
- `EIXO_ALLOWED_ORIGINS`: origens HTTPS exatas, separadas por vírgula, sem barra final nem curinga; a origem atual é `https://bright-melomakarona-0510ff.netlify.app`
- `EIXO_LEADS_ENABLED`: `true` habilita o servidor apenas com configuração válida; em novos ambientes, manter `false` até a ativação ser autorizada

Prefira escopo de Functions para o segredo quando disponível. Não registre credenciais em código, Git, comandos, logs ou arquivos públicos. Este projeto não injeta variáveis de ambiente no frontend. O exemplo de ambiente não é carregado automaticamente pelo código e não deve substituir a configuração ativa.

Funil ausente, etapa ambígua, vínculo inválido, configuração incompleta ou origem não autorizada impedem o envio. A função só confirma sucesso após resposta válida do CRM com os IDs dos dois registros persistidos. Respostas incertas bloqueiam nova tentativa na página; não há repetição automática de POST. O limite de 5 requisições por 180 segundos por IP/domínio é declarado na configuração da função e depende da aplicação pela Netlify.

## Publicação e cuidados

Este repositório é uma cópia de fonte, sem vinculação automática ao projeto Netlify. Uma publicação futura deve ser autorizada e incluir tanto `site/` quanto `netlify/functions/`, preservando a importação relativa da validação compartilhada. O upload apenas dos arquivos estáticos não publica a função.

Não amplie as origens permitidas, altere o destino no CRM, conecte outro domínio ou faça novo teste real por inferência. Um envio real pode criar registros ou atualizar contato existente no CRM e precisa usar dados explicitamente aprovados. Em caso de recebimento incerto, verifique o atendimento antes de reenviar.

O WhatsApp comercial publicado é o de Fabio Vinicios, **(94) 99163-6639**. O número pessoal usado em teste não integra este repositório. As alternativas de WhatsApp e formulário original foram preservadas.

O aviso de tratamento de dados da página é descritivo. Identidade completa do controlador, retenção, bases legais e política de privacidade final ainda exigem revisão do responsável.
