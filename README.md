# WhatsApp Bot (Sem API Oficial) 🚀

Este projeto é uma demonstração de como automatizar o WhatsApp Web utilizando **Python** e **Selenium**.

## ✨ Funcionalidades
- **Conectividade:** Usa o WhatsApp Web real através de um navegador controlado.
- **Sessão Persistente:** Salva o login na pasta `chrome_profile`, assim você só precisa escanear o QR Code uma vez.
- **Envio Direto:** Utiliza links diretos de API para agilizar o envio de mensagens.

## 🛠️ Requisitos
1. **Python 3.x** instalado.
2. **Google Chrome** instalado.

## 🚀 Como usar
1. Instale as dependências:
   ```bash
   py -m pip install -r requirements.txt
   ```
2. Execute o bot:
   ```bash
   py bot.py
   ```
3. O Chrome abrirá o WhatsApp Web. Escaneie o QR Code com seu celular.
4. Use o menu no terminal para enviar mensagens.

## ⚠️ Avisos Importantes (Segurança)
Este é um método não oficial. Para evitar que sua conta seja bloqueada pelo WhatsApp:
- **Não faça Spam:** Envie mensagens apenas para pessoas que esperam seu contato.
- **Intervalos:** Se for enviar muitas mensagens, adicione pausas (`time.sleep`) entre elas.
- **Números Novos:** Evite usar contas de WhatsApp recém-criadas para automação intensa.

## 📁 Estrutura do Projeto
- `bot.py`: O código principal do robô.
- `requirements.txt`: Dependências do projeto.
- `chrome_profile/`: Pasta que será criada automaticamente para salvar sua sessão de login.
