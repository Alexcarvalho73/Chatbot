from flask import Flask, render_template, request, jsonify
from bot import WhatsAppBot
import threading

app = Flask(__name__)
bot = WhatsAppBot()

# Inicia o bot automaticamente
def start_bot():
    threading.Thread(target=bot.start, daemon=True).start()

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/status')
def get_status():
    return jsonify(bot.get_status())

@app.route('/force_connect', methods=['POST'])
def force_connect():
    bot.force_connect()
    return jsonify({"success": True})

@app.route('/restart', methods=['POST'])
def restart():
    threading.Thread(target=bot.start, daemon=True).start()
    return jsonify({"success": True})

@app.route('/send', methods=['POST'])
def send():
    data = request.json
    phone = data.get('phone')
    message = data.get('message')
    
    if not phone or not message:
        return jsonify({"success": False, "message": "Telefone e mensagem são obrigatórios."}), 400
        
    success, msg = bot.send_message(phone, message)
    return jsonify({"success": success, "message": msg})

if __name__ == '__main__':
    # Usando o bot.start() aqui também para garantir que inicie sem precisar do primeiro request se necessário
    start_bot()
    app.run(debug=False, port=5002)
