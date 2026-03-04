/* =====================================================
   BRANDING LEGADO DESATIVADO
   Motivo:
   - Chave antiga: empresa_configurada
   - Branding atual ? offline-first via:
     localStorage.vsc_empresa_v1.__logoA
   - Controle feito exclusivamente por vsc-topbar.js
   ===================================================== */
// (function(){
//   try {
//     var ok = localStorage.getItem('empresa_configurada');
//     if (ok !== '1') {
//       var logo = document.querySelector('.topbar img, .brand img, #logoEmpresa');
//       if (logo) logo.remove();
//       console.info('[BRANDING] Empresa n?o configurada. Logo n?o aplicada.');
//       return;
//     }
//   } catch(e){}
// })();
/**
 * ERP VETERIN?f??,??,?RIO - BIBLIOTECA JAVASCRIPT CORE
 * Vers?f??,??,?o: 2.0.1
 * Autor: ERP Vet Team
 * ?f??,??,?ltima atualiza?f??,??,??f??,??,?o: 2026-01-20
 */
window.ERPVet = (function() {
    'use strict';



;(() => {
  try {
    var id = 'patch-topbar-bold';
    var s = document.getElementById(id);
    if (!s) {
      s = document.createElement('style');
      s.id = id;
      (document.head || document.documentElement).appendChild(s);
    }

   var css =
  '/* PATCH P3.2: TOPBAR BOLD (LINKS+BUTTONS) */\n' +
  '/* Links do menu + botões/pílulas/tabs no header/topbar */\n' +
  'header a, header nav a, header .nav a, header .menu a, header .topbar a, .vsc-topbar a, .vsc-topbar nav a,\n' +
  'header button, header nav button, header .nav button, header .menu button, header .topbar button, .vsc-topbar button,\n' +
  'header .btn, header .button, header .pill, header .chip, header .tab, header [role="button"],\n' +
  '.vsc-topbar .btn, .vsc-topbar .button, .vsc-topbar .pill, .vsc-topbar .chip, .vsc-topbar .tab, .vsc-topbar [role="button"]\n' +
  '{ font-weight: 700 !important; }\n';

    // mantém eventual CSS anterior e garante a regra P3.2
    var prev = (s.textContent || '');
    if (prev.indexOf('PATCH P3.2: TOPBAR BOLD (LINKS+BUTTONS)') === -1) {
      s.textContent = (prev ? (prev + '\n') : '') + css;
    }
  } catch (e) { /* noop */ }
})();
;(() => {
  try {
    if (document.getElementById('patch-topbar-bold')) return;
    var s = document.createElement('style');
    s.id = 'patch-topbar-bold';
    s.textContent =
      '/* PATCH P3.1: TOPBAR BOLD */' + '\n' +
      'header a, header nav a, header .nav a, header .menu a, header .topbar a, .vsc-topbar a, .vsc-topbar nav a {' + '\n' +
      '  font-weight: 700 !important;' + '\n' +
      '}' + '\n';
    (document.head || document.documentElement).appendChild(s);
  } catch (e) { /* noop */ }
})();
    // ==========================================
    // CONFIGURAÇÕES
    // ==========================================
    
    const CONFIG = {
        version: '2.0.1',
        appName: 'Vet System Control',
        appNameEquine: 'Vet System Control | Equine',
        storagePrefix: 'vsc_',
        apiURL: '/api',
        debug: true
    };

    // ==========================================
    // UTILIT?f??,??,?RIOS
    // ==========================================
    
    const Utils = {
        /**
         * Remove todos os caracteres n?f??,??,?o num?f??,??,?ricos
         */
        onlyDigits(str) {
            return (str || '').toString().replace(/\D+/g, '');
        },

        /**
         * Normaliza nome para compara?f??,??,??f??,??,?o
         */
        normalizeName(str) {
            return (str || '').toString().trim().toLowerCase()
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '')
                .replace(/[^a-z0-9 ]/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();
        },

        /**
         * Calcula similaridade entre strings (Jaccard)
         */
        similarity(a, b) {
            a = this.normalizeName(a);
            b = this.normalizeName(b);
            
            if (!a || !b) return 0;
            if (a === b) return 1;
            
            const setA = new Set(a.split(' '));
            const setB = new Set(b.split(' '));
            let intersection = 0;
            
            setA.forEach(word => {
                if (setB.has(word)) intersection++;
            });
            
            const union = new Set([...setA, ...setB]).size || 1;
            return intersection / union;
        },

        /**
         * Formata CPF
         */
        formatCPF(cpf) {
            const digits = this.onlyDigits(cpf);
            if (digits.length !== 11) return cpf;
            return digits.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
        },

        /**
         * Formata CNPJ
         */
        formatCNPJ(cnpj) {
            const digits = this.onlyDigits(cnpj);
            if (digits.length !== 14) return cnpj;
            return digits.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
        },

        /**
         * Formata telefone
         */
        formatPhone(phone) {
            const digits = this.onlyDigits(phone);
            if (digits.length === 11) {
                return digits.replace(/(\d{2})(\d{5})(\d{4})/, '($1) $2-$3');
            } else if (digits.length === 10) {
                return digits.replace(/(\d{2})(\d{4})(\d{4})/, '($1) $2-$3');
            }
            return phone;
        },

        /**
         * Formata CEP
         */
        formatCEP(cep) {
            const digits = this.onlyDigits(cep);
            if (digits.length === 8) {
                return digits.replace(/(\d{5})(\d{3})/, '$1-$2');
            }
            return cep;
        },

        /**
         * Formata moeda BRL
         */
        formatCurrency(value) {
            return new Intl.NumberFormat('pt-BR', {
                style: 'currency',
                currency: 'BRL'
            }).format(value);
        },

        /**
         * Formata data BR
         */
        formatDate(date) {
            if (!date) return '';
            const d = new Date(date);
            return d.toLocaleDateString('pt-BR');
        },

        /**
         * Gera ID ?f??,??,?nico
         */
        generateID(prefix = 'id') {
            return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
        },

        /**
         * Debounce function
         */
        debounce(func, wait = 300) {
            let timeout;
            return function executedFunction(...args) {
                const later = () => {
                    clearTimeout(timeout);
                    func(...args);
                };
                clearTimeout(timeout);
                timeout = setTimeout(later, wait);
            };
        },

        /**
         * Log debug
         */
        log(...args) {
            if (CONFIG.debug) {
                console.log('[ERP Vet]', ...args);
            }
        },

        /**
         * Log erro
         */
        error(...args) {
            console.error('[ERP Vet ERROR]', ...args);
        }
    };

    // ==========================================
    // VALIDA?f??,??,??f??,??,?ES
    // ==========================================
    
    const Validator = {
        /**
         * Valida CPF
         */
        validateCPF(cpf) {
            cpf = Utils.onlyDigits(cpf);
            
            if (cpf.length !== 11 || /^(\d)\1+$/.test(cpf)) return false;
            
            let soma = 0, resto;
            
            for (let i = 1; i <= 9; i++) {
                soma += parseInt(cpf.substring(i-1, i)) * (11 - i);
            }
            resto = (soma * 10) % 11;
            if (resto === 10 || resto === 11) resto = 0;
            if (resto !== parseInt(cpf.substring(9, 10))) return false;
            
            soma = 0;
            for (let i = 1; i <= 10; i++) {
                soma += parseInt(cpf.substring(i-1, i)) * (12 - i);
            }
            resto = (soma * 10) % 11;
            if (resto === 10 || resto === 11) resto = 0;
            if (resto !== parseInt(cpf.substring(10, 11))) return false;
            
            return true;
        },

        /**
         * Valida CNPJ
         */
        validateCNPJ(cnpj) {
            cnpj = Utils.onlyDigits(cnpj);
            
            if (cnpj.length !== 14 || /^(\d)\1+$/.test(cnpj)) return false;
            
            const calcDV = (base) => {
                const weights = base.length === 12 
                    ? [5,4,3,2,9,8,7,6,5,4,3,2] 
                    : [6,5,4,3,2,9,8,7,6,5,4,3,2];
                
                let soma = 0;
                for (let i = 0; i < weights.length; i++) {
                    soma += parseInt(base.charAt(i)) * weights[i];
                }
                const resto = soma % 11;
                return resto < 2 ? 0 : 11 - resto;
            };
            
            const base12 = cnpj.substring(0, 12);
            const dv1 = calcDV(base12);
            const base13 = base12 + dv1;
            const dv2 = calcDV(base13);
            
            return cnpj.charAt(12) === String(dv1) && cnpj.charAt(13) === String(dv2);
        },

        /**
         * Valida documento (CPF ou CNPJ)
         */
        validateDocument(doc) {
            const digits = Utils.onlyDigits(doc);
            if (digits.length === 11) return this.validateCPF(digits);
            if (digits.length === 14) return this.validateCNPJ(digits);
            return false;
        },

        /**
         * Valida e-mail
         */
        validateEmail(email) {
            const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            return re.test(email);
        },

        /**
         * Valida telefone
         */
        validatePhone(phone) {
            const digits = Utils.onlyDigits(phone);
            return digits.length === 10 || digits.length === 11;
        }
    };

    // ==========================================
    // STORAGE (LocalStorage)
    // ==========================================
    
    const Storage = {
        /**
         * Salva dados no localStorage
         */
        save(key, data) {
            try {
                const fullKey = CONFIG.storagePrefix + key;
                localStorage.setItem(fullKey, JSON.stringify(data));
                Utils.log(`Storage: salvo ${key}`, data);
                return true;
            } catch (error) {
                Utils.error('Erro ao salvar no storage:', error);
                return false;
            }
        },

        /**
         * Carrega dados do localStorage
         */
        load(key, defaultValue = null) {
            try {
                const fullKey = CONFIG.storagePrefix + key;
                const data = localStorage.getItem(fullKey);
                if (data === null) return defaultValue;
                return JSON.parse(data);
            } catch (error) {
                Utils.error('Erro ao carregar do storage:', error);
                return defaultValue;
            }
        },

        /**
         * Remove item do localStorage
         */
        remove(key) {
            try {
                const fullKey = CONFIG.storagePrefix + key;
                localStorage.removeItem(fullKey);
                Utils.log(`Storage: removido ${key}`);
                return true;
            } catch (error) {
                Utils.error('Erro ao remover do storage:', error);
                return false;
            }
        },

        /**
         * Limpa todo o storage do app
         */
        clear() {
            try {
                const keys = Object.keys(localStorage);
                keys.forEach(key => {
                    if (key.startsWith(CONFIG.storagePrefix)) {
                        localStorage.removeItem(key);
                    }
                });
                Utils.log('Storage: limpo completamente');
                return true;
            } catch (error) {
                Utils.error('Erro ao limpar storage:', error);
                return false;
            }
        }
    };

    // ==========================================
    // UI - MENSAGENS
    // ==========================================
    
    const UI = {
        /**
         * Mostra mensagem de alerta
         */
        showMessage(message, type = 'info', duration = 5000) {
            const container = document.getElementById('messageContainer') || this.createMessageContainer();
            
            const alert = document.createElement('div');
            alert.className = `alert alert-${type} animate-fadeIn`;
            alert.innerHTML = `
                <span>${this.getIcon(type)}</span>
                <span>${message}</span>
            `;
            
            container.appendChild(alert);
            
            if (duration > 0) {
                setTimeout(() => {
                    alert.style.opacity = '0';
                    setTimeout(() => alert.remove(), 300);
                }, duration);
            }
            
            return alert;
        },

        /**
         * Cria container de mensagens
         */
        createMessageContainer() {
            const container = document.createElement('div');
            container.id = 'messageContainer';
            container.style.cssText = `
                position: fixed;
                top: 20px;
                right: 20px;
                z-index: 9999;
                display: flex;
                flex-direction: column;
                gap: 10px;
                max-width: 400px;
            `;
            document.body.appendChild(container);
            return container;
        },

        /**
         * Retorna ?f??,??,?cone baseado no tipo
         */
        getIcon(type) {
            const icons = {
                success: '?',
                error: '?',
                warning: '?',
                info: '?'
            };
            return icons[type] || icons.info;
        },

        /**
         * Mostra loading
         */
        showLoading(message = 'Carregando...') {
            const overlay = document.createElement('div');
            overlay.id = 'loadingOverlay';
            overlay.style.cssText = `
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background: rgba(0, 0, 0, 0.5);
                display: flex;
                align-items: center;
                justify-content: center;
                z-index: 99999;
            `;
            overlay.innerHTML = `
                <div style="background: white; padding: 30px; border-radius: 12px; text-align: center;">
                    <div style="font-size: 24px; margin-bottom: 10px;">?</div>
                    <div>${message}</div>
                </div>
            `;
            document.body.appendChild(overlay);
        },

        /**
         * Esconde loading
         */
        hideLoading() {
            const overlay = document.getElementById('loadingOverlay');
            if (overlay) overlay.remove();
        },

        /**
         * Confirma?f??,??,??f??,??,?o
         */
        confirm(message, onConfirm, onCancel) {
            if (window.confirm(message)) {
                if (onConfirm) onConfirm();
            } else {
                if (onCancel) onCancel();
            }
        }
    };

    // ==========================================
    // BUSCA DE CEP
    // ==========================================
    
    const CEP = {
        /**
         * Busca CEP na API ViaCEP
         */
        async buscar(cep) {
            const digits = Utils.onlyDigits(cep);
            
            if (digits.length !== 8) {
                throw new Error('CEP deve ter 8 d?f??,??,?gitos');
            }
            
            try {
                const response = await fetch(`https://viacep.com.br/ws/${digits}/json/`);
                
                if (!response.ok) {
                    throw new Error(`Erro HTTP: ${response.status}`);
                }
                
                const data = await response.json();
                
                if (data.erro) {
                    throw new Error('CEP n?f??,??,?o encontrado');
                }
                
                return {
                    cep: data.cep,
                    logradouro: data.logradouro || '',
                    complemento: data.complemento || '',
                    bairro: data.bairro || '',
                    cidade: data.localidade || '',
                    uf: data.uf || '',
                    ibge: data.ibge || ''
                };
            } catch (error) {
                Utils.error('Erro ao buscar CEP:', error);
                throw error;
            }
        },

        /**
         * Preenche campos de endere?f??,??,?o
         */
        async preencherCampos(cep, campos) {
            try {
                UI.showLoading('Buscando CEP...');
                
                const endereco = await this.buscar(cep);
                
                if (campos.logradouro) campos.logradouro.value = endereco.logradouro;
                if (campos.bairro) campos.bairro.value = endereco.bairro;
                if (campos.cidade) campos.cidade.value = endereco.cidade;
                if (campos.uf) campos.uf.value = endereco.uf;
                
                UI.hideLoading();
                UI.showMessage('CEP encontrado!', 'success', 2000);
                
                if (campos.numero) campos.numero.focus();
                
                return endereco;
            } catch (error) {
                UI.hideLoading();
                UI.showMessage(error.message, 'error');
                throw error;
            }
        }
    };

    // ==========================================
    // NAVEGA?f??,??,??f??,??,?O ENTRE CAMPOS (Enter)
    // ==========================================
    
    const Navigation = {
        /**
         * Inicializa navega?f??,??,??f??,??,?o por Enter
         */
        init(formSelector = 'form') {
            document.addEventListener('keydown', (e) => {
                if (e.key !== 'Enter') return;
                
                const target = e.target;
                const form = target.closest(formSelector);
                
                if (!form) return;
                if (target.tagName === 'TEXTAREA' && !e.ctrlKey) return;
                if (target.tagName === 'BUTTON') return;
                
                e.preventDefault();
                
                const fields = this.getFocusableFields(form);
                const currentIndex = fields.indexOf(target);
                
                if (currentIndex >= 0 && currentIndex < fields.length - 1) {
                    const nextField = fields[currentIndex + 1];
                    nextField.focus();
                    if (nextField.select) nextField.select();
                }
            }, true);
            
            console.log("[ERP Vet] Navegação por Enter inicializada");

        },

        /**
         * Retorna campos foc?f??,??,?veis do formul?f??,??,?rio
         */
        getFocusableFields(form) {
            const selector = 'input:not([type="hidden"]):not([type="button"]), select, textarea';
            return Array.from(form.querySelectorAll(selector)).filter(field => {
                return !field.disabled && 
                       window.getComputedStyle(field).display !== 'none' &&
                       window.getComputedStyle(field).visibility !== 'hidden';
            });
        }
    };

    // ==========================================
    // API REST
    // ==========================================
    
    const API = {
        baseURL: 'http://127.0.0.1:8081',
        
        /**
         * Requisi?f??,??,??f??,??,?o gen?f??,??,?rica
         */
        async request(endpoint, options = {}) {
            try {
                const url = `${this.baseURL}${endpoint}`;
                const config = {
                    headers: {
                        'Content-Type': 'application/json',
                        ...options.headers
                    },
                    ...options
                };
                
                const response = await fetch(url, config);
                
                if (!response.ok) {
                    const error = await response.json().catch(() => ({ error: 'Erro desconhecido' }));
                    throw new Error(error.error || `Erro HTTP: ${response.status}`);
                }
                
                return await response.json();
            } catch (error) {
                Utils.error('Erro na requisi?f??,??,??f??,??,?o:', error);
                throw error;
            }
        },
        
        /**
         * GET
         */
        async get(endpoint) {
            return this.request(endpoint, { method: 'GET' });
        },
        
        /**
         * POST
         */
        async post(endpoint, data) {
            return this.request(endpoint, {
                method: 'POST',
                body: JSON.stringify(data)
            });
        },
        
        /**
         * PUT
         */
        async put(endpoint, data) {
            return this.request(endpoint, {
                method: 'PUT',
                body: JSON.stringify(data)
            });
        },
        
        /**
         * DELETE
         */
        async delete(endpoint) {
            return this.request(endpoint, { method: 'DELETE' });
        },
        
        // CLIENTES
        async getClientes() {
            return this.get('/clientes');
        },
        
        async getCliente(id) {
            return this.get(`/clientes/${id}`);
        },
        
        async createCliente(data) {
            return this.post('/clientes', data);
        },
        
        async updateCliente(id, data) {
            return this.put(`/clientes/${id}`, data);
        },
        
        async deleteCliente(id) {
            return this.delete(`/clientes/${id}`);
        },
        
        // ANIMAIS
        async getAnimais(clienteId = null) {
            const query = clienteId ? `?cliente_id=${clienteId}` : '';
            return this.get(`/animais${query}`);
        },
        
        async getAnimal(id) {
            return this.get(`/animais/${id}`);
        },
        
        async createAnimal(data) {
            return this.post('/animais', data);
        },
        
        async updateAnimal(id, data) {
            return this.put(`/animais/${id}`, data);
        },
        
        async deleteAnimal(id) {
            return this.delete(`/animais/${id}`);
        },
        
        // ATENDIMENTOS
        async getAtendimentos(filters = {}) {
            const params = new URLSearchParams(filters).toString();
            const query = params ? `?${params}` : '';
            return this.get(`/atendimentos${query}`);
        },
        
        async getAtendimento(id) {
            return this.get(`/atendimentos/${id}`);
        },
        
        async createAtendimento(data) {
            return this.post('/atendimentos', data);
        },
        
        async updateAtendimento(id, data) {
            return this.put(`/atendimentos/${id}`, data);
        },
        
        async deleteAtendimento(id) {
            return this.delete(`/atendimentos/${id}`);
        },
        
        // PRODUTOS
        async getProdutos(params = {}) {
            const query = new URLSearchParams(params).toString();
            return this.get(query ? `/produtos?${query}` : '/produtos');
        },
        
        async getProduto(id) {
            return this.get(`/produtos/${id}`);
        },
        
        async createProduto(data) {
            return this.post('/produtos', data);
        },
        
        async updateProduto(id, data) {
            return this.put(`/produtos/${id}`, data);
        },
        
        async deleteProduto(id) {
            return this.delete(`/produtos/${id}`);
        },
        
        async getProdutoLotes(produto_id) {
            return this.get(`/produtos/${produto_id}/lotes`);
        },
        
        async createLote(produto_id, data) {
            return this.post(`/produtos/${produto_id}/lotes`, data);
        },
        
        // FORNECEDORES
        async getFornecedores() {
            return this.get('/fornecedores');
        },
        
        async getFornecedor(id) {
            return this.get(`/fornecedores/${id}`);
        },
        
        async createFornecedor(data) {
            return this.post('/fornecedores', data);
        },
        
        async updateFornecedor(id, data) {
            return this.put(`/fornecedores/${id}`, data);
        },
        
        async deleteFornecedor(id) {
            return this.delete(`/fornecedores/${id}`);
        },
        
        // FINANCEIRO
        async getFinanceiro(params = {}) {
            const query = new URLSearchParams(params).toString();
            return this.get(query ? `/financeiro?${query}` : '/financeiro');
        },
        
        async getResumoFinanceiro(cliente_id = null) {
            const query = cliente_id ? `?cliente_id=${cliente_id}` : '';
            return this.get(`/financeiro/resumo${query}`);
        },
        
        async createFinanceiro(data) {
            return this.post('/financeiro', data);
        },
        
        async pagarFinanceiro(id, data) {
            return this.post(`/financeiro/${id}/pagar`, data);
        },
        
        async getFechamentos(params = {}) {
            const query = new URLSearchParams(params).toString();
            return this.get(query ? `/financeiro/fechamentos?${query}` : '/financeiro/fechamentos');
        },
        
        async createFechamento(data) {
            return this.post('/financeiro/fechamentos', data);
        },
        
        async pagarFechamento(id, data) {
            return this.post(`/financeiro/fechamentos/${id}/pagar`, data);
        },
        
        // XML/NFe
        async uploadXML(formData) {
            return fetch(`${this.baseURL}/xml/upload`, {
                method: 'POST',
                body: formData
            }).then(r => r.json());
        },
        
        async getXMLs(status = null) {
            const query = status ? `?status=${status}` : '';
            return this.get(`/xml${query}`);
        },
        
        async getXML(id) {
            return this.get(`/xml/${id}`);
        },
        
        async mapearProdutoXML(xml_id, data) {
            return this.post(`/xml/${xml_id}/mapear-produto`, data);
        },
        
        async processarXML(xml_id) {
            return this.post(`/xml/${xml_id}/processar`, {});
        },
        
        async deleteXML(id) {
            return this.delete(`/xml/${id}`);
        },
        
        // ESTAT?f??,??,?STICAS
        async getEstatisticas() {
            return this.get('/estatisticas');
        },
        
        /**
         * Verifica se o backend est?f??,??,? online
         */
        async checkHealth() {
            try {
                await this.get('/');
                return true;
            } catch {
                return false;
            }
        }
    };

    // ==========================================
    // API P?f??,??,?BLICA
    // ==========================================
    
    return {
        CONFIG,
        Utils,
        Validator,
        Storage,
        UI,
        CEP,
        Navigation,
        API,
        
        /**
         * Inicializa o sistema
         */
        init() {
            Utils.log(`Iniciando ${CONFIG.appName} v${CONFIG.version}`);
            Navigation.init();
            Utils.log('Sistema inicializado com sucesso!');
        }
    };

})();

// Auto-inicializa?f??,??,??f??,??,?o
document.addEventListener('DOMContentLoaded', () => {
    ERPVet.init();
});

;(() => {
  // VSC_BRANDING_LOGO_A_TOPBAR_E9_V1
  // Regra: Logo A do cliente (empresa.html) deve aparecer na topbar (canto direito) quando existir.
  // Fonte: localStorage 'vsc_empresa_v1' -> '__logoA' (dataURL).
  // N?f?'?,?o altera layout; apenas preenche um slot existente, se encontrado.

  function safeJsonParse(s){ try { return JSON.parse(s); } catch(e){ return null; } }

  function findLogoSlot(){
    // Prioriza IDs mais prov?f?'?,?veis, depois seletores gen?f?'?,?ricos e atributos.
    const selectors = [
      '#logoEmpresa', '#empresaLogo', '#logoA', '#topbarLogoA', '#vscLogoA',
      'img[data-empresa-logo]', 'img[data-logo-a]', '.empresa-logo img', '.logo-empresa img',
      '.topbar .empresa-logo img', '.topbar .logo-empresa img',
      'header img#logoEmpresa', 'header img.empresa-logo', 'header img.logo-empresa'
    ];
    for (const sel of selectors){
      const el = document.querySelector(sel);
      if (el) return el;
    }

    // Fallback: procura no header por um IMG do lado direito (sem tocar no logo do sistema ?f?'?,? esquerda)
    const header = document.querySelector('header');
    if(!header) return null;
    const imgs = Array.from(header.querySelectorAll('img'));
    if(imgs.length <= 1) return null;

    // heur?f?'?,?stica: pega o ?f?'?,?ltimo img do header (frequentemente ?f?'?,? o slot da direita)
    return imgs[imgs.length - 1] || null;
  }

  function applyLogoA(){
    const slot = findLogoSlot();
    if(!slot) return;

    const raw = localStorage.getItem('vsc_empresa_v1');
    const obj = raw ? safeJsonParse(raw) : null;
    const logoA = obj && obj.__logoA ? String(obj.__logoA) : '';

    if(logoA && logoA.startsWith('data:image')){
      // aplica
      try{
        slot.src = logoA;
      }catch(e){}
      try{
        slot.style.display = '';
        slot.style.visibility = 'visible';
        slot.style.opacity = '1';
      }catch(e){}
      try{
        slot.setAttribute('alt', 'Logo da empresa');
      }catch(e){}
      try{
        console.log('[BRANDING] Logo A aplicada (localStorage).');
      }catch(e){}
    } else {
      // sem logo: mantém branco/oculto como regra
      try{
        slot.removeAttribute('src');
      }catch(e){}
      try{
        slot.style.display = 'none';
      }catch(e){}
      try{
                console.log("[BRANDING] Empresa não configurada. Logo não aplicada.");
      }catch(e){}
    }
  }

  // aplica no load e também quando o storage mudar (ex: outra aba salvou)
  document.addEventListener('DOMContentLoaded', applyLogoA, { once:false });
  window.addEventListener('storage', (ev) => {
    if(ev && ev.key === 'vsc_empresa_v1') applyLogoA();
  });
})();

;(() => {
  // VSC_TOPBAR_LOGO_A_SLOT_E10_V1
  // Regra: Logo A do cliente deve aparecer na topbar (lado direito) quando existir.
  // Fonte: localStorage 'vsc_empresa_v1' -> '__logoA' (dataURL).
  // Comportamento: se n?f?'?,?o existir logo, slot fica oculto (branco).

  function safeParse(s){ try { return JSON.parse(s); } catch(e){ return null; } }

  function ensureSlot(){
    const topbar = document.querySelector('.vsc-topbar');
    if(!topbar) return null;

    let img = topbar.querySelector('#vscLogoEmpresaA');
    if(img) return img;

    img = document.createElement('img');
    img.id = 'vscLogoEmpresaA';
    img.alt = 'Logo da empresa';

    // Estilo m?f?'?,?nimo (n?f?'?,?o muda topbar; s?f?'?,? garante boa visualiza?f?'?,??f?'?,?o)
        // VSC_TOPBAR_LOGO_A_STYLE_E11_V1
    // Ajuste visual: encaixa a logo entre as linhas da topbar e centraliza verticalmente
    img.style.maxHeight = '56px';
    img.style.height = '56px';
    img.style.width = 'auto';
    img.style.objectFit = 'contain';
    img.style.display = 'none';

    // Centraliza?f?'?,??f?'?,?o e ?f????s??.??oencaixe?f????s??,? no flex da topbar
    img.style.alignSelf = 'center';
    img.style.verticalAlign = 'middle';
        // VSC_TOPBAR_LOGO_A_ALIGN_E12_V1
    // Centraliza?f?'?,??f?'?,?o horizontal visual entre menu e borda direita
    img.style.margin = '0 18px 0 18px';
    img.style.padding = '0';

    // Inser?f?'?,??f?'?,?o segura: antes do ?f?'?,?ltimo elemento (normalmente a?f?'?,??f?'?,?es/?f?'?,?cone da direita)
    // Se n?f?'?,?o houver filhos, apenas adiciona.
    const last = topbar.lastElementChild;
    if(last){
      topbar.insertBefore(img, last);
    } else {
      topbar.appendChild(img);
    }

    return img;
  }

  function applyLogoA(){
    const img = ensureSlot();
    if(!img) return;

    const raw = localStorage.getItem('vsc_empresa_v1');
    const obj = raw ? safeParse(raw) : null;
    const logoA = (obj && obj.__logoA) ? String(obj.__logoA) : '';

    if(logoA && logoA.startsWith('data:image')){
      img.src = logoA;
      img.style.display = '';
      img.style.visibility = 'visible';
      img.style.opacity = '1';
      try{ console.log('[BRANDING] Logo A aplicada na topbar.'); }catch(e){}
    } else {
      // Sem logo -> oculto
      img.removeAttribute('src');
      img.style.display = 'none';
      try{ console.log('[BRANDING] Logo A ausente. Slot oculto.'); }catch(e){}
    }
  }

  document.addEventListener('DOMContentLoaded', applyLogoA);
  window.addEventListener('storage', (ev) => {
    if(ev && ev.key === 'vsc_empresa_v1') applyLogoA();
  });

  // Refor?f?'?,?o: aplica ap?f?'?,?s pequenos atrasos (caso a topbar seja montada depois)
  setTimeout(applyLogoA, 250);
  setTimeout(applyLogoA, 1000);
})();

;(() => {
  // VSC_TOPBAR_LOGO_A_CENTER_E13_V1
  // Centraliza a Logo A no espa?f?'?,?o ENTRE o item "Empresa" do menu e a borda direita interna da topbar.
  // N?f?'?,?o mexe no menu nem no logo do sistema; apenas reposiciona #vscLogoEmpresaA quando existir.

  function px(n){ return (Math.round(n) + 'px'); }

  function findEmpresaAnchor(topbar){
    // tenta achar o item do menu "Empresa" pelo texto
    const candidates = topbar.querySelectorAll('a, button, .nav-link, .menu a, nav a, nav button');
    for(const el of candidates){
      const t = (el.textContent || '').trim();
      if(t === 'Empresa') return el;
    }
    // fallback: pega o ?f?'?,?ltimo link do nav (se existir)
    const nav = topbar.querySelector('nav') || topbar;
    const links = nav.querySelectorAll('a,button,.nav-link');
    if(links && links.length) return links[links.length - 1];
    return null;
  }

  function centerLogoA(){
    const topbar = document.querySelector('.vsc-topbar');
    const logo = document.querySelector('#vscLogoEmpresaA');
    if(!topbar || !logo) return;

    // s?f?'?,? reposiciona se estiver vis?f?'?,?vel (quando h?f?'?,? logo)
    if(!logo.src || logo.style.display === 'none') return;

    const anchor = findEmpresaAnchor(topbar);
    if(!anchor) return;

    // garante base para posicionamento
    if(getComputedStyle(topbar).position === 'static'){
      topbar.style.position = 'relative';
    }

    // posicionamento absoluto apenas da logo (pontual)
    logo.style.position = 'absolute';
    logo.style.top = '50%';
    logo.style.transform = 'translateY(-50%)';
    logo.style.right = ''; // limpa
    logo.style.left = '';  // seta abaixo

    const tb = topbar.getBoundingClientRect();
    const an = anchor.getBoundingClientRect();
    const lg = logo.getBoundingClientRect();

    const cs = getComputedStyle(topbar);
    const padR = parseFloat(cs.paddingRight || '0') || 0;

    const leftLimit  = an.right;                 // fim do bot?f?'?,?o Empresa
    const rightLimit = tb.right - padR;          // borda direita interna

    const available = rightLimit - leftLimit;
    if(available <= 40) return; // sem espa?f?'?,?o

    const desiredLeft = leftLimit + (available - lg.width) / 2;

    // clamping para n?f?'?,?o encostar
    const minLeft = leftLimit + 10;
    const maxLeft = rightLimit - lg.width - 10;

    const finalLeft = Math.max(minLeft, Math.min(desiredLeft, maxLeft));

    logo.style.left = px(finalLeft - tb.left);

    // Garantias visuais (n?f?'?,?o muda tamanho aprovado)
    logo.style.margin = '0';
    logo.style.alignSelf = 'auto';
  }

  // recalcula em load + resize + pequenos delays (topbar pode montar depois)
  window.addEventListener('resize', () => { centerLogoA(); });
  document.addEventListener('DOMContentLoaded', () => {
    centerLogoA();
    setTimeout(centerLogoA, 150);
    setTimeout(centerLogoA, 600);
    setTimeout(centerLogoA, 1200);
  });

  // se a logo for aplicada depois, tenta centralizar em seguida
  setTimeout(centerLogoA, 2000);
})();

//
// VSC_EMPRESA_API_BEGIN
// Integra?f?'?,??f?'?,?o ONLINE-First da tela Empresa com backend .NET (http://127.0.0.1:8081)
// - N?f?'?,?o altera layout/topbar
// - Ativa somente em empresa.html
(function () {
  try {
    const API_BASE = "http://127.0.0.1:8081";

    function isEmpresaPage() {
      const p = (location.pathname || "").toLowerCase();
      return p.endsWith("/empresa.html") || p === "empresa.html" || p.endsWith("\\empresa.html");
    }

    function log(...args) { try { console.log("[EMPRESA][API]", ...args); } catch {} }
    function warn(...args) { try { console.warn("[EMPRESA][API]", ...args); } catch {} }

    // Localiza input por lista de ids/names comuns
    function pickField(candidates) {
      for (const key of candidates) {
        const byId = document.getElementById(key);
        if (byId) return byId;
        const byName = document.querySelector(`[name="${key}"]`);
        if (byName) return byName;
        const byData = document.querySelector(`[data-field="${key}"]`);
        if (byData) return byData;
      }
      return null;
    }

    // Mapeamento tolerante (ids/names variam)
    const FIELDS = {
      razaoSocial:  ["razaoSocial","razao_social","razao","razaosocial"],
      nomeFantasia:["nomeFantasia","nome_fantasia","fantasia","nomefantasia"],
      cnpj:         ["cnpj","CNPJ"],
      ie:           ["ie","inscricaoEstadual","inscricao_estadual"],
      cnae:         ["cnae","cnaePrincipal","cnae_principal"],
      cep:          ["cep","CEP"],
      logradouro:   ["logradouro","endereco","rua"],
      numero:       ["numero","num","n"],
      complemento:  ["complemento","comp"],
      bairro:       ["bairro"],
      cidade:       ["cidade","municipio"],
      uf:           ["uf","estado"],
      ibge:         ["ibge","codIbge","codigoIbge","codigo_ibge"],
      telefone:     ["telefone","fone","tel"],
      email:        ["email","e-mail","mail"],
      celular:      ["celular","whatsapp","celularWhatsapp","celular_whatsapp","wpp","cel"]
    };

    function getDomValues() {
      const out = {};
      // l?f?'?,? todos os campos definidos acima
      for (const prop of Object.keys(FIELDS)) {
        const el = pickField(FIELDS[prop]);
        if (el) {
          out[prop] = (el.value ?? "").toString().trim();
        }
      }

      // alguns front-ends usam "celular" como telefone, aqui n?f?'?,?o for?f?'?,?amos; apenas enviamos o que existe.
      // backend ignora campos desconhecidos, ent?f?'?,?o mantemos somente os do modelo.
      return {
        razaoSocial: out.razaoSocial || null,
        nomeFantasia: out.nomeFantasia || null,
        cnpj: out.cnpj || null,
        ie: out.ie || null,
        cnae: out.cnae || null,
        cep: out.cep || null,
        logradouro: out.logradouro || null,
        numero: out.numero || null,
        complemento: out.complemento || null,
        bairro: out.bairro || null,
        cidade: out.cidade || null,
        uf: out.uf || null,
        ibge: out.ibge || null,
        telefone: (out.celular && !out.telefone) ? out.celular : (out.telefone || null),
        email: out.email || null
      };
    }

    function setDomValues(data) {
      if (!data) return;
      const setIf = (prop, val) => {
        if (val === undefined || val === null) return;
        const el = pickField(FIELDS[prop]);
        if (el && (el.value ?? "") !== String(val)) el.value = String(val);
      };

      setIf("razaoSocial", data.razaoSocial);
      setIf("nomeFantasia", data.nomeFantasia);
      setIf("cnpj", data.cnpj);
      setIf("ie", data.ie);
      setIf("cnae", data.cnae);

      setIf("cep", data.cep);
      setIf("logradouro", data.logradouro);
      setIf("numero", data.numero);
      setIf("complemento", data.complemento);
      setIf("bairro", data.bairro);
      setIf("cidade", data.cidade);
      setIf("uf", data.uf);
      setIf("ibge", data.ibge);

      setIf("telefone", data.telefone);
      setIf("celular", data.telefone); // espelha, se o front s?f?'?,? tiver "celular/whatsapp"
      setIf("email", data.email);
    }

    async function apiGetEmpresa() {
      const r = await fetch(`${API_BASE}/api/empresa`, { method: "GET" });
      if (!r.ok) throw new Error(`GET /api/empresa -> ${r.status}`);
      return await r.json();
    }

    async function apiPostEmpresa(payload) {
      const r = await fetch(`${API_BASE}/api/empresa`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (!r.ok) throw new Error(`POST /api/empresa -> ${r.status}`);
      return await r.json();
    }

    function findButtonByText(text) {
      const norm = (s) => (s || "").toString().trim().toLowerCase();
      const t = norm(text);
      const btns = Array.from(document.querySelectorAll("button, a.btn, input[type='button'], input[type='submit']"));
      for (const b of btns) {
        const label = b.tagName === "INPUT" ? (b.value || "") : (b.textContent || "");
        if (norm(label) === t) return b;
      }
      return null;
    }

    function bindOnlineHandlers() {
      const btnSalvar = findButtonByText("salvar");
      const btnRecarregar = findButtonByText("recarregar");

      if (btnSalvar) {
        btnSalvar.addEventListener("click", async (ev) => {
          try {
            // N?f?'?,?o bloqueia outros handlers do sistema; apenas executa antes/depois.
            const payload = getDomValues();
            log("POST /api/empresa (payload resumido)", { razaoSocial: payload.razaoSocial, cnpj: payload.cnpj, cep: payload.cep });
            const saved = await apiPostEmpresa(payload);
            setDomValues(saved);
            log("Salvo no backend com sucesso.");
          } catch (e) {
            warn("Falha ao salvar no backend. Mantendo comportamento offline. Detalhe:", e?.message || e);
          }
        }, { capture: true });
      } else {
               warn("Botão SALVAR não localizado por texto. (Nada a fazer)");
      }

      if (btnRecarregar) {
        btnRecarregar.addEventListener("click", async (ev) => {
          try {
            log("GET /api/empresa");
            const data = await apiGetEmpresa();
            setDomValues(data);
            log("Dados carregados do backend.");
          } catch (e) {
            warn("Falha ao carregar do backend. Mantendo comportamento offline. Detalhe:", e?.message || e);
          }
        }, { capture: true });
      } else {
            warn("Botão RECARREGAR não localizado por texto. (Nada a fazer)");
      }
    }

    async function initialLoadFromApi() {
      try {
        log("Inicializando carregamento ONLINE (GET /api/empresa)...");
        const data = await apiGetEmpresa();
        setDomValues(data);
        log("Carregado do backend.");
      } catch (e) {
                warn("Backend indisponível no carregamento inicial. Continuando em modo offline. Detalhe:", e?.message || e);
      }
    }

    if (isEmpresaPage()) {
      document.addEventListener("DOMContentLoaded", () => {
        bindOnlineHandlers();
        initialLoadFromApi();
      });
    }
  } catch (e) {
    try { console.warn("[EMPRESA][API] Falha ao inicializar bloco:", e?.message || e); } catch {}
  }
})();
// VSC_EMPRESA_API_END


;(() => {
  // VSC_OUTBOX_RELAY_AUTOLOAD_V1 — garante que o relay exista para telas offline-first
  // Padrão enterprise: um único worker de sync (Transactional Outbox) reutilizado por todas as telas.
  try {
    if (window.VSC_LOAD_RELAY) return;

    window.VSC_LOAD_RELAY = function VSC_LOAD_RELAY(){
      return new Promise((resolve, reject) => {
        try {
          if (window.VSC_RELAY && typeof window.VSC_RELAY.kick === "function") return resolve(window.VSC_RELAY);

          var id = "vsc-relay-autoload";
          var el = document.getElementById(id);
          if (el) {
            // aguarda carregar
            el.addEventListener("load", () => resolve(window.VSC_RELAY));
            el.addEventListener("error", () => reject(new Error("Falha ao carregar relay")));
            return;
          }

          var s = document.createElement("script");
          s.id = id;
          s.src = "modules/vsc-outbox-relay.js?v=20260225";
          s.defer = true;
          s.onload = () => {
            if (window.VSC_RELAY && typeof window.VSC_RELAY.kick === "function") return resolve(window.VSC_RELAY);
            return reject(new Error("Relay carregou, mas VSC_RELAY não foi exposto"));
          };
          s.onerror = () => reject(new Error("Falha ao carregar relay"));
          (document.head || document.documentElement).appendChild(s);
        } catch (e) {
          reject(e);
        }
      });
    };

    // Best effort: carregar cedo para reduzir latência ao clicar em "Sincronizar"
    if (!(window.VSC_RELAY && typeof window.VSC_RELAY.kick === "function")) {
      try { window.VSC_LOAD_RELAY().catch(() => {}); } catch (_) {}
    }
  } catch (_) {}
})();



;(() => {
  // VSC_LICENSE_AUTOLOAD_V1 — carrega licenciamento global (premium) sem editar dezenas de telas
  try {
    if (window.VSC_LICENSE) return;
    var id = 'vsc-license-autoload';
    if (document.getElementById(id)) return;
    var s = document.createElement('script');
    s.id = id;
    s.src = 'modules/vsc-license.js?v=20260222';
    s.defer = true;
    (document.head || document.documentElement).appendChild(s);
  } catch (_) {}
})();
