import os
import time
from urllib.parse import quote
from selenium import webdriver
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from webdriver_manager.chrome import ChromeDriverManager
import threading

class WhatsAppBot:
    def __init__(self):
        self.status = "Iniciando..."
        self.driver = None
        self.is_logged_in = False
        self.auto_reply_enabled = True
        self._lock = threading.Lock()
        self.processed_messages = set() # Para evitar responder a mesma mensagem várias vezes

    def start(self):
        """Inicializa o driver com limpeza de processos antigos"""
        if self.driver:
            try:
                self.driver.current_url
                return 
            except:
                self.driver = None

        print("🧹 Limpando instâncias anteriores do Chrome...")
        try:
            os.system("taskkill /f /im chrome.exe /t")
            os.system("taskkill /f /im chromedriver.exe /t")
            time.sleep(2)
        except:
            pass
        
        self.is_logged_in = False
        self.status = "Iniciando motor do navegador..."
        
        chrome_options = Options()
        script_dir = os.path.dirname(os.path.abspath(__file__))
        user_data_dir = os.path.join(script_dir, "chrome_profile")
        chrome_options.add_argument(f"user-data-dir={user_data_dir}")
        chrome_options.add_argument("--no-sandbox")
        chrome_options.add_argument("--disable-dev-shm-usage")
        # chrome_options.add_argument("--headless") # Opcional: oculte o navegador se desejar

        try:
            service = Service(ChromeDriverManager().install())
            self.driver = webdriver.Chrome(service=service, options=chrome_options)
            self.wait = WebDriverWait(self.driver, 60)
        except Exception as e:
            if "user data directory is already in use" in str(e).lower():
                self.status = "ERRO: Feche todas as janelas do Chrome antes de iniciar."
            else:
                self.status = f"Erro ao abrir Chrome: {str(e)[:50]}"
            print(f"❌ ERRO CRÍTICO: {e}")
            return
        
        self.status = "Aguardando login no WhatsApp Web..."
        self.driver.get("https://web.whatsapp.com")
        
        # Inicia monitoramento de login e escuta de mensagens
        threading.Thread(target=self._monitor_login, daemon=True).start()
        threading.Thread(target=self._listen_loop, daemon=True).start()

    def _monitor_login(self):
        try:
            print("🔍 Monitorando detecção de login...")
            # Tenta encontrar a lista de chats ou a barra de busca (mais robusto)
            selectors = [
                '//div[@data-testid="chat-list"]',
                '//div[@id="pane-side"]',
                '//div[@contenteditable="true"][@data-tab="3"]',
                '//header[@data-testid="chatlist-header"]',
                '//div[@data-testid="default-user"]', # Foto de perfil
                '//span[@data-icon="chat"]' # Ícone de nova conversa
            ]
            
            # Loop de verificação para atualizar status
            start_time = time.time()
            while time.time() - start_time < 300: # 5 minutos de tolerância
                # Verifica se logou (procura qualquer um dos seletores de interface logada)
                for selector in selectors:
                    try:
                        elements = self.driver.find_elements(By.XPATH, selector)
                        if len(elements) > 0:
                            self.is_logged_in = True
                            self.status = "Conectado"
                            print(f"✅ WhatsApp conectado (Detectado por: {selector})")
                            return
                    except:
                        continue

                # Se não logou, verifica se o QR Code está visível
                try:
                    qr_elements = self.driver.find_elements(By.XPATH, '//canvas[@aria-label="Scan me!"]')
                    if len(qr_elements) > 0:
                        self.status = "Aguardando escaneamento do QR Code..."
                except:
                    pass
                
                time.sleep(1)
            
            self.status = "Tempo esgotado: Por favor, reinicie e escaneie o QR Code."
        except Exception as e:
            self.status = f"Erro no Login: {str(e)}"
            print(f"Erro no login: {e}")

    def send_message(self, phone, message):
        if not self.is_logged_in:
            return False, "WhatsApp não está conectado."
        
        if not self.driver:
            return False, "O navegador ainda não foi inicializado. Aguarde alguns segundos."

        with self._lock:
            try:
                print(f"📧 Iniciando envio para {phone}...")
                encoded_message = quote(message)
                url = f"https://web.whatsapp.com/send?phone={phone}&text={encoded_message}"
                self.driver.get(url)
                
                # Lista de possíveis seletores para o botão de enviar
                send_selectors = [
                    '//span[@data-icon="send"]',
                    '//button[@aria-label="Enviar"]',
                    '//button[@data-testid="compose-btn-send"]',
                    '//div[@data-testid="send"]'
                ]
                
                button = None
                # Aguarda o carregamento (pode demorar dependendo da internet)
                print("⏳ Aguardando botão de envio aparecer...")
                
                for selector in send_selectors:
                    try:
                        button = WebDriverWait(self.driver, 15).until(
                            EC.element_to_be_clickable((By.XPATH, selector))
                        )
                        if button:
                            print(f"🎯 Botão encontrado usando: {selector}")
                            break
                    except:
                        continue
                
                if button:
                    time.sleep(1.5) # Pausa de segurança
                    button.click()
                    print(f"✨ Mensagem enviada para {phone} via clique!")
                    time.sleep(2)
                    return True, "Mensagem enviada com sucesso!"
                else:
                    # Redundância: Tenta pressionar ENTER no campo de texto
                    try:
                        print("⌨️ Tentando enviar via tecla ENTER...")
                        input_xpath = '//div[@contenteditable="true"][@data-tab="10"]'
                        input_box = self.driver.find_element(By.XPATH, input_xpath)
                        input_box.send_keys(Keys.ENTER)
                        time.sleep(2)
                        print(f"✨ Mensagem enviada para {phone} via ENTER!")
                        return True, "Mensagem enviada via ENTER!"
                    except:
                        pass

                    # Verifica se o número é inválido
                    try:
                        if "inválido" in self.driver.page_source.lower():
                            return False, "Número de telefone inválido ou não possui WhatsApp."
                    except:
                        pass
                    return False, "Tempo esgotado: O botão de enviar não apareceu."
                    
            except Exception as e:
                print(f"❌ Erro detalhado no envio: {str(e)}")
                return False, f"Falha ao enviar: {str(e)}"

    def _listen_loop(self):
        """Loop que monitora novas mensagens recebidas"""
        while True:
            if self.is_logged_in and self.auto_reply_enabled:
                try:
                    # 1. VERIFICA CHATS NÃO LIDOS (Bolinha verde)
                    unread_chats_xpath = '//span[contains(@aria-label, "não lida") or contains(@aria-label, "unread")]/ancestor::div[@role="row"]'
                    unread_chats = self.driver.find_elements(By.XPATH, unread_chats_xpath)
                    
                    for chat in unread_chats:
                        with self._lock:
                            chat.click()
                            time.sleep(1.5)
                            self._process_active_chat()
                    
                    # 2. VERIFICA O CHAT QUE JÁ ESTÁ ABERTO (Foco atual)
                    with self._lock:
                        self._process_active_chat()
                                
                    time.sleep(3)
                except Exception as e:
                    if "invalid session id" in str(e).lower() or "no such window" in str(e).lower():
                        print("🚫 Sessão do navegador perdida.")
                        self.is_logged_in = False
                        self.driver = None
                        return
                    time.sleep(2)
            else:
                time.sleep(5)

    def _process_active_chat(self):
        """Lê a última mensagem da tela atual e responde se for 1 ou 2"""
        try:
            # Seletores para mensagens recebidas (incoming)
            # Tenta múltiplos padrões de span de texto
            msg_selectors = [
                '//div[contains(@class, "message-in")]//span[@dir="ltr"]',
                '//div[contains(@class, "message-in")]//div[contains(@class, "copyable-text")]/span',
                '//div[contains(@class, "message-in")]//span[contains(@class, "selectable-text")]'
            ]
            
            messages = []
            for selector in msg_selectors:
                messages = self.driver.find_elements(By.XPATH, selector)
                if messages: break
                
            if messages:
                last_msg_element = messages[-1]
                text = last_msg_element.text.strip()
                
                # Identificador único para não responder a mesma mensagem 2 vezes
                # Usamos o texto + a posição/id se possível (aqui simplificado por texto e tempo)
                msg_id = f"{text}_{last_msg_element.location}"
                
                if msg_id not in self.processed_messages:
                    print(f"📩 Nova mensagem detectada: '{text}'")
                    if text == "1":
                        self._send_raw_message("Aceito")
                        print("🤖 Respondi 'Aceito'")
                    elif text == "2":
                        self._send_raw_message("Recusado")
                        print("🤖 Respondi 'Recusado'")
                    
                    self.processed_messages.add(msg_id)
        except Exception as e:
            pass

    def _send_raw_message(self, text):
        """Envia uma mensagem no chat que já está aberto"""
        try:
            # Encontra o campo de digitação
            input_xpath = '//div[@contenteditable="true"][@data-tab="10"]'
            input_box = self.wait.until(EC.presence_of_element_located((By.XPATH, input_xpath)))
            input_box.send_keys(text)
            time.sleep(0.5)
            
            # Encontra o botão de enviar
            send_btn_xpath = '//span[@data-icon="send"]'
            send_btn = self.wait.until(EC.element_to_be_clickable((By.XPATH, send_btn_xpath)))
            send_btn.click()
        except Exception as e:
            print(f"Erro ao responder: {e}")

    def force_connect(self):
        if self.driver:
            self.is_logged_in = True
            self.status = "Conectado (Manual)"
            print("💡 Conexão forçada pelo usuário.")
            return True
        else:
            self.status = "ERRO: O navegador não abriu. Tente reiniciar o sistema."
            return False

    def get_status(self):
        return {
            "status": self.status,
            "connected": self.is_logged_in
        }
