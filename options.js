document.addEventListener('DOMContentLoaded', function() {
  // 获取DOM元素
  const serverUrlInput = document.getElementById('serverUrl');
  const secretInput = document.getElementById('secret');
  const saveBtn = document.getElementById('saveBtn');
  const refreshBtn = document.getElementById('refreshBtn');
  const statusDiv = document.getElementById('status');
  const loadingDiv = document.getElementById('loading');
  const apiConfigTable = document.getElementById('apiConfigTable');
  const autoFillCheckbox = document.getElementById('autoFillCode');
  const customCodePatternInput = document.getElementById('customCodePattern');
  const saveCodeBtn = document.getElementById('saveCodeBtn');
  const autoFillPhoneCheckbox = document.getElementById('autoFillPhone');
  const phoneNumberInput = document.getElementById('phoneNumber');
  const phoneCountryCodeInput = document.getElementById('phoneCountryCode');
  const savePhoneBtn = document.getElementById('savePhoneBtn');
  
  // 加载保存的设置
  loadSettings();
  
  // 加载验证码设置
  loadCodeSettings();

  // 加载手机号设置
  loadPhoneSettings();
  
  // 显示接口配置表格
  displayApiConfig();
  
  // 保存按钮点击事件
  saveBtn.addEventListener('click', function() {
    saveSettings();
  });
  
  // 刷新按钮点击事件
  refreshBtn.addEventListener('click', function() {
    // 获取当前保存的设置并刷新配置信息
    chrome.storage.sync.get(['serverUrl', 'secret'], function(items) {
      if (items.serverUrl && items.secret) {
        fetchApiConfig(items.serverUrl, items.secret);
      } else {
        showStatus('请先保存服务器URL和签名密钥', 'error');
      }
    });
  });

  // 保存验证码设置按钮
  saveCodeBtn.addEventListener('click', function() {
    saveCodeSettings();
  });

  // 保存手机号设置按钮
  savePhoneBtn.addEventListener('click', function() {
    savePhoneSettings();
  });

  // 加载验证码设置
  function loadCodeSettings() {
    chrome.storage.sync.get(['autoFillCode', 'customCodePattern'], function(items) {
      autoFillCheckbox.checked = items.autoFillCode !== false;
      if (items.customCodePattern) {
        customCodePatternInput.value = items.customCodePattern;
      }
    });
  }

  // 加载手机号设置
  function loadPhoneSettings() {
    chrome.storage.sync.get(['autoFillPhone', 'phoneNumber', 'phoneCountryCode'], function(items) {
      autoFillPhoneCheckbox.checked = items.autoFillPhone !== false;
      if (items.phoneNumber) {
        phoneNumberInput.value = items.phoneNumber;
      }
      if (items.phoneCountryCode) {
        phoneCountryCodeInput.value = items.phoneCountryCode;
      }
    });
  }

  // 保存手机号设置
  function savePhoneSettings() {
    const autoFill = autoFillPhoneCheckbox.checked;
    const phone = phoneNumberInput.value.trim();
    const countryCode = phoneCountryCodeInput.value.trim() || '+86';

    // 简单验证手机号格式（11位数字）
    if (phone && !/^1\d{10}$/.test(phone)) {
      showStatus('手机号格式不正确，应为11位数字（以1开头）', 'error');
      return;
    }

    chrome.storage.sync.set({
      autoFillPhone: autoFill,
      phoneNumber: phone,
      phoneCountryCode: countryCode
    }, function() {
      showStatus('手机号设置已保存', 'success');
    });
  }

  // 保存验证码设置
  function saveCodeSettings() {
    const autoFill = autoFillCheckbox.checked;
    const pattern = customCodePatternInput.value.trim();

    // 如果填写了自定义正则，验证其有效性
    if (pattern) {
      try {
        new RegExp(pattern);
      } catch (e) {
        showStatus('自定义正则表达式无效: ' + e.message, 'error');
        return;
      }
    }

    chrome.storage.sync.set({
      autoFillCode: autoFill,
      customCodePattern: pattern
    }, function() {
      showStatus('验证码设置已保存', 'success');
    });
  }
  
  // 加载设置函数
  function loadSettings() {
    chrome.storage.sync.get(['serverUrl', 'secret', 'apiConfigData', 'lastUpdateTime'], function(items) {
      if (items.serverUrl) {
        serverUrlInput.value = items.serverUrl;
      }
      if (items.secret) {
        secretInput.value = items.secret;
      }
      
      // 显示上次更新时间（如果有）
      if (items.lastUpdateTime) {
        document.getElementById('lastUpdateTime').textContent = `上次更新时间: ${items.lastUpdateTime}`;
      }
      
      // 如果已有设置，从接口获取配置信息并展示
      if (items.serverUrl && items.secret) {
        fetchApiConfig(items.serverUrl, items.secret);
      } else if (items.apiConfigData) {
        // 如果有保存的配置数据但没有服务器设置，显示保存的配置数据
        displayApiConfig(items.apiConfigData);
      } else {
        // 否则显示默认接口配置表格
        displayApiConfig();
      }
    });
  }
  
  // 保存设置函数
  function saveSettings() {
    const serverUrl = serverUrlInput.value.trim();
    const secret = secretInput.value.trim();
    
    // 验证输入
    if (!serverUrl) {
      showStatus('请输入服务器URL', 'error');
      return;
    }
    
    if (!secret) {
      showStatus('请输入签名密钥', 'error');
      return;
    }
    
    // 验证URL格式
    try {
      new URL(serverUrl);
    } catch (e) {
      showStatus('服务器URL格式不正确', 'error');
      return;
    }
    
    // 保存设置
    chrome.storage.sync.set(
      {
        serverUrl: serverUrl,
        secret: secret
      },
      function() {
        showStatus('设置已保存', 'success');
        // 从接口获取配置信息并展示
        fetchApiConfig(serverUrl, secret);
      }
    );
  }
  
  // 从接口获取配置信息并显示
  async function fetchApiConfig(serverUrl, secret) {
    try {
      // 显示加载状态
      showStatus('正在获取配置信息...', 'info');
      
      // 显示加载动画，隐藏表格
      loadingDiv.style.display = 'block';
      apiConfigTable.style.display = 'none';
      
      // 准备请求参数
      const timestamp = Date.now().toString();
      const sign = await SharedCrypto.generateSign(secret, timestamp);
      
      // 构建请求URL和数据 - 使用/config/query接口
      const url = serverUrl + "/config/query";
      const requestData = {
        timestamp: parseInt(timestamp),
        sign: sign
      };
      
      // 发送请求
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify(requestData),
        signal: AbortSignal.timeout(10000), // 10秒超时
        mode: 'cors',
        credentials: 'same-origin'
      });
      
      if (!response.ok) {
        throw new Error(`HTTP error! Status: ${response.status}`);
      }
      
      const data = await response.json();
      
      if (data.code === 200 || data.code === 0) {
        // 显示成功获取的消息
        showStatus('成功获取配置信息', 'success');
        
        // 处理返回的数据，确保格式正确
        let formattedData = {};
        
        // 如果data.data是对象，直接使用
        if (data.data && typeof data.data === 'object') {
          // 处理配置项
          const configItems = [
            'enable_api_battery_query', 'enable_api_call_query', 'enable_api_clone',
            'enable_api_contact_query', 'enable_api_sms_query', 'enable_api_sms_send',
            'enable_api_wol', 'extra_device_mark', 'extra_sim1', 'extra_sim2', 'sim_info_list'
          ];
          
          // 创建格式化的数据对象
          configItems.forEach(key => {
            // 检查键是否存在于返回的数据中
            if (key in data.data) {
              const value = data.data[key];
              const type = typeof value;
              
              formattedData[key] = {
                type: type.charAt(0).toUpperCase() + type.slice(1),
                required: ['enable_api_battery_query', 'enable_api_call_query', 'enable_api_clone',
                          'enable_api_contact_query', 'enable_api_sms_query', 'enable_api_sms_send',
                          'enable_api_wol'].includes(key),
                description: getDescription(key),
                value: value
              };
            }
          });
        }
        
        // 保存配置数据和当前时间到本地存储
        const saveTime = new Date().toLocaleString();
        chrome.storage.sync.set({ 
          apiConfigData: formattedData,
          lastUpdateTime: saveTime 
        }, function() {
          console.log('配置数据已保存到本地存储');
          // 更新显示的时间
          document.getElementById('lastUpdateTime').textContent = `上次更新时间: ${saveTime}`;
        });
        
        // 解析并显示配置信息
        displayApiConfig(formattedData);
      } else {
        // 如果接口返回错误，显示错误信息并使用默认配置
        showStatus(`获取配置信息失败: ${data.msg || '未知错误'}，使用默认配置`, 'error');
        displayApiConfig();
      }
      
      // 获取配置项描述的辅助函数
      function getDescription(key) {
        const descriptions = {
          'enable_api_battery_query': '远程查电量',
          'enable_api_call_query': '远程查通话',
          'enable_api_clone': '一键换新机',
          'enable_api_contact_query': '远程查话簿',
          'enable_api_sms_query': '远程查短信',
          'enable_api_sms_send': '远程发短信',
          'enable_api_wol': '远程WOL',
          'extra_device_mark': '设备备注(v3.0.5+)',
          'extra_sim1': 'SIM1备注(v3.0.5+)',
          'extra_sim2': 'SIM2备注(v3.0.5+)',
          'sim_info_list': 'SIM信息列表(实时卡槽信息)(v3.0.5+)'
        };
        
        return descriptions[key] || '无说明';
      }
    } catch (error) {
      // 如果请求出错，显示错误信息并使用默认配置
      showStatus(`获取配置信息失败: ${error.message}，使用默认配置`, 'error');
      displayApiConfig();
    } finally {
      // 无论成功还是失败，都隐藏加载动画
      loadingDiv.style.display = 'none';
    }
  }
  
  // 显示接口配置表格
  function displayApiConfig(apiConfigData) {
    // 如果没有传入配置数据，尝试从本地存储获取
    if (!apiConfigData) {
      chrome.storage.sync.get(['apiConfigData', 'lastUpdateTime'], function(items) {
        if (items.apiConfigData) {
          // 如果本地存储中有配置数据，使用它
          // 显示上次更新时间
          if (items.lastUpdateTime) {
            document.getElementById('lastUpdateTime').textContent = `上次更新时间: ${items.lastUpdateTime}`;
          }
          displayApiConfig(items.apiConfigData);
          return;
        } else {
          // 如果本地存储中没有配置数据，使用默认配置
          apiConfigData = {
            "enable_api_battery_query": { "type": "Boolean", "required": true, "description": "远程查电量", "value": false },
            "enable_api_call_query": { "type": "Boolean", "required": true, "description": "远程查通话", "value": false },
            "enable_api_clone": { "type": "Boolean", "required": true, "description": "一键换新机", "value": false },
            "enable_api_contact_query": { "type": "Boolean", "required": true, "description": "远程查话簿", "value": false },
            "enable_api_sms_query": { "type": "Boolean", "required": true, "description": "远程查短信", "value": false },
            "enable_api_sms_send": { "type": "Boolean", "required": true, "description": "远程发短信", "value": false },
            "enable_api_wol": { "type": "Boolean", "required": true, "description": "远程WOL", "value": false },
            "extra_device_mark": { "type": "String", "required": false, "description": "设备备注(v3.0.5+)", "value": null },
            "extra_sim1": { "type": "String", "required": false, "description": "SIM1备注(v3.0.5+)", "value": null },
            "extra_sim2": { "type": "String", "required": false, "description": "SIM2备注(v3.0.5+)", "value": null },
            "sim_info_list": { "type": "Object", "required": false, "description": "SIM信息列表(实时卡槽信息)(v3.0.5+)", "value": null }
          };
          
          // 继续渲染表格
          renderConfigTable(apiConfigData);
        }
      });
      return; // 提前返回，等待异步获取完成
    }
    
    // 如果有传入配置数据，直接渲染
    renderConfigTable(apiConfigData);
  }
  
  // 渲染配置表格
  function renderConfigTable(apiConfigData) {
    // 如果传入的apiConfigData为空，使用默认配置
    if (!apiConfigData) {
      apiConfigData = {
        "enable_api_battery_query": { "type": "Boolean", "required": true, "description": "远程查电量", "value": false },
        "enable_api_call_query": { "type": "Boolean", "required": true, "description": "远程查通话", "value": false },
        "enable_api_clone": { "type": "Boolean", "required": true, "description": "一键换新机", "value": false },
        "enable_api_contact_query": { "type": "Boolean", "required": true, "description": "远程查话簿", "value": false },
        "enable_api_sms_query": { "type": "Boolean", "required": true, "description": "远程查短信", "value": false },
        "enable_api_sms_send": { "type": "Boolean", "required": true, "description": "远程发短信", "value": false },
        "enable_api_wol": { "type": "Boolean", "required": true, "description": "远程WOL", "value": false },
        "extra_device_mark": { "type": "String", "required": false, "description": "设备备注(v3.0.5+)", "value": null },
        "extra_sim1": { "type": "String", "required": false, "description": "SIM1备注(v3.0.5+)", "value": null },
        "extra_sim2": { "type": "String", "required": false, "description": "SIM2备注(v3.0.5+)", "value": null },
        "sim_info_list": { "type": "Object", "required": false, "description": "SIM信息列表(实时卡槽信息)(v3.0.5+)", "value": null }
      };
    }
    
    // 获取表格元素（apiConfigTable已在全局定义）
    const apiConfigTableBody = document.getElementById('apiConfigTableBody');
    
    // 清空表格内容
    apiConfigTableBody.innerHTML = '';
    
    // 确保表格可见
    apiConfigTable.style.display = 'block';
    
    // 填充表格
    for (const [key, config] of Object.entries(apiConfigData)) {
      const row = document.createElement('tr');
      
      // 配置项
      const keyCell = document.createElement('td');
      keyCell.textContent = key;
      row.appendChild(keyCell);
      
      // 类型
      const typeCell = document.createElement('td');
      typeCell.textContent = config.type || typeof config;
      row.appendChild(typeCell);
      
      // 必填
      const requiredCell = document.createElement('td');
      requiredCell.textContent = config.required ? '是' : '否';
      row.appendChild(requiredCell);
      
      // 说明
      const descriptionCell = document.createElement('td');
      descriptionCell.textContent = config.description || '无说明';
      row.appendChild(descriptionCell);
      
      // 值（如果存在）
      if (typeof config !== 'object' || config.value !== undefined) {
        const valueCell = document.createElement('td');
        const value = typeof config === 'object' ? config.value : config;
        
        if (typeof value === 'boolean') {
          valueCell.textContent = value ? '已启用' : '已禁用';
          valueCell.style.color = value ? '#28a745' : '#dc3545';
          valueCell.style.fontWeight = 'bold';
        } else if (value === null || value === undefined) {
          valueCell.textContent = '未设置';
          valueCell.style.color = '#6c757d';
          valueCell.style.fontStyle = 'italic';
        } else if (typeof value === 'object') {
          if (key === 'sim_info_list' && value) {
            // 为SIM卡信息创建一个更友好的显示
            const simInfoDiv = document.createElement('div');
            simInfoDiv.style.maxHeight = '150px';
            simInfoDiv.style.overflowY = 'auto';
            simInfoDiv.style.padding = '5px';
            simInfoDiv.style.border = '1px solid #ddd';
            simInfoDiv.style.borderRadius = '4px';
            simInfoDiv.style.backgroundColor = '#f9f9f9';
            
            // 遍历SIM卡信息
            Object.entries(value).forEach(([slotId, simInfo]) => {
              const simCard = document.createElement('div');
              simCard.style.marginBottom = '8px';
              simCard.style.padding = '5px';
              simCard.style.borderBottom = '1px solid #eee';
              
              // 添加SIM卡槽信息
              const slotTitle = document.createElement('div');
              slotTitle.textContent = `SIM卡槽 ${slotId}`;
              slotTitle.style.fontWeight = 'bold';
              slotTitle.style.marginBottom = '3px';
              simCard.appendChild(slotTitle);
              
              // 添加SIM卡详细信息
              if (simInfo) {
                const infoList = document.createElement('ul');
                infoList.style.margin = '0';
                infoList.style.paddingLeft = '15px';
                infoList.style.fontSize = '12px';
                
                // 显示SIM卡的各项属性
                for (const [key, value] of Object.entries(simInfo)) {
                  if (value !== null && value !== undefined) {
                    const item = document.createElement('li');
                     
                     // 格式化显示值
                     let displayValue = value;
                     
                     // 处理布尔值
                     if (typeof value === 'boolean') {
                       displayValue = value ? '是' : '否';
                       item.style.color = value ? '#28a745' : '#6c757d';
                     }
                     
                     // 处理网络类型
                     if (key === 'networkType' || key === 'dataNetworkType') {
                       displayValue = formatNetworkType(value);
                     }
                     
                     // 处理SIM卡状态
                     if (key === 'simState') {
                       displayValue = formatSimState(value);
                     }
                     
                     item.textContent = `${formatSimInfoKey(key)}: ${displayValue}`;
                     infoList.appendChild(item);
                   }
                 }
                 
                 // 格式化网络类型
                 function formatNetworkType(type) {
                   const networkTypes = {
                     0: '未知',
                     1: 'GPRS',
                     2: 'EDGE',
                     3: 'UMTS',
                     4: 'CDMA',
                     5: 'EVDO_0',
                     6: 'EVDO_A',
                     7: '1xRTT',
                     8: 'HSDPA',
                     9: 'HSUPA',
                     10: 'HSPA',
                     11: 'IDEN',
                     12: 'EVDO_B',
                     13: 'LTE',
                     14: 'EHRPD',
                     15: 'HSPAP',
                     16: 'GSM',
                     17: 'TD_SCDMA',
                     18: 'IWLAN',
                     19: 'LTE_CA',
                     20: 'NR'
                   };
                   
                   return networkTypes[type] || type;
                 }
                 
                 // 格式化SIM卡状态
                 function formatSimState(state) {
                   const simStates = {
                     0: '未知',
                     1: '不存在',
                     2: '已锁定',
                     3: 'PUK已锁定',
                     4: 'PIN已锁定',
                     5: '网络已锁定',
                     6: '就绪',
                     7: '未就绪',
                     8: '已禁用',
                     9: '已格式化',
                     10: '受限',
                     11: '卡错误'
                   };
                   
                   return simStates[state] || state;
                 }
                
                simCard.appendChild(infoList);
              } else {
                const noInfo = document.createElement('div');
                noInfo.textContent = '无SIM卡信息';
                noInfo.style.fontStyle = 'italic';
                noInfo.style.color = '#6c757d';
                simCard.appendChild(noInfo);
              }
              
              simInfoDiv.appendChild(simCard);
            });
            
            // 如果没有SIM卡信息
            if (Object.keys(value).length === 0) {
              const noSimInfo = document.createElement('div');
              noSimInfo.textContent = '无SIM卡信息';
              noSimInfo.style.fontStyle = 'italic';
              noSimInfo.style.color = '#6c757d';
              noSimInfo.style.padding = '5px';
              simInfoDiv.appendChild(noSimInfo);
            }
            
            valueCell.appendChild(simInfoDiv);
          } else {
            // 其他对象类型，使用JSON字符串显示
            valueCell.textContent = JSON.stringify(value);
            valueCell.style.fontFamily = 'monospace';
            valueCell.style.fontSize = '12px';
          }
          
          // 格式化SIM卡信息的键名
          function formatSimInfoKey(key) {
            const keyMap = {
              'imei': 'IMEI',
              'imsi': 'IMSI',
              'number': '号码',
              'carrier': '运营商',
              'country': '国家',
              'slot': '卡槽',
              'ready': '就绪状态',
              'active': '激活状态',
              'displayName': '显示名称',
              'iccId': 'ICC ID',
              'subscriptionId': '订阅ID',
              'mcc': 'MCC',
              'mnc': 'MNC',
              'networkType': '网络类型',
              'simSlotIndex': 'SIM卡槽索引',
              'isNetworkRoaming': '是否漫游',
              'isMultiSim': '是否多卡',
              'phoneNumber': '电话号码',
              'deviceId': '设备ID',
              'networkOperator': '网络运营商',
              'networkOperatorName': '网络运营商名称',
              'dataNetworkType': '数据网络类型',
              'phoneType': '电话类型',
              'simState': 'SIM卡状态',
              'isDataEnabled': '数据是否启用'
            };
            
            return keyMap[key] || key;
          }
        } else {
          valueCell.textContent = String(value);
        }
        
        row.appendChild(valueCell);
      }
      
      apiConfigTableBody.appendChild(row);
    }
  }
  
  // 显示状态信息
  function showStatus(message, type) {
    statusDiv.textContent = message;
    statusDiv.className = 'status';
    if (type) {
      statusDiv.classList.add(type);
    }
    statusDiv.style.display = 'block';
    
    // 3秒后自动隐藏成功消息
    if (type === 'success') {
      setTimeout(function() {
        statusDiv.style.display = 'none';
      }, 3000);
    }
  }

});