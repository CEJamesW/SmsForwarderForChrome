document.addEventListener('DOMContentLoaded', function() {
  // 获取DOM元素 - 公共元素
  const statusDiv = document.getElementById('status');
  const settingsLink = document.getElementById('settingsLink');
  
  // 获取DOM元素 - 标签页
  const smsQueryTab = document.getElementById('smsQueryTab');
  const sendTab = document.getElementById('sendTab');
  const queryTab = document.getElementById('queryTab');
  const tabs = document.querySelectorAll('.tab');
  const tabContents = document.querySelectorAll('.tab-content');
  
  // 获取DOM元素 - 查询短信
  const querySmsTypeSelect = document.getElementById('querySmsType');
  const querySmsKeywordInput = document.getElementById('querySmsKeyword');
  const smsQueryResultDiv = document.getElementById('smsQueryResult');
  
  // 分页相关变量
  let currentPage = 1;
  let hasMoreData = true;
  let isLoading = false;
  let currentSmsType = querySmsTypeSelect.value;
  let currentKeyword = '';
  
  // 新增：默认短信类型常量，用于本地数据的类型兼容
  const DEFAULT_SMS_TYPE = 1;
  
  // 页面加载时自动查询短信 - 默认查询接收的短信，关键字为空
  querySmsMessages(querySmsTypeSelect.value, '', true);
  
  // 当短信类型选择变化时，自动查询短信
  querySmsTypeSelect.addEventListener('change', function() {
    currentSmsType = this.value;
    currentKeyword = querySmsKeywordInput.value.trim();
    resetPagination();
    querySmsMessages(currentSmsType, currentKeyword, true);
  });
  
  // 当关键字输入框内容变化时，添加防抖处理
  let keywordDebounceTimer;
  querySmsKeywordInput.addEventListener('input', function() {
    clearTimeout(keywordDebounceTimer);
    keywordDebounceTimer = setTimeout(() => {
      currentSmsType = querySmsTypeSelect.value;
      currentKeyword = this.value.trim();
      resetPagination();
      querySmsMessages(currentSmsType, currentKeyword, true);
    }, 500); // 500毫秒的防抖延迟
  });
  
  // 监听后台轮询的更新消息，收到后刷新当前查询列表
  SharedBus.on(SharedBus.Types.SMS_LIST_UPDATED, (payload, sender, sendResponse) => {
    try {
      // 保持用户当前筛选条件，重置分页并刷新
      resetPagination();
      currentSmsType = querySmsTypeSelect.value;
      currentKeyword = querySmsKeywordInput.value.trim();
      querySmsMessages(currentSmsType, currentKeyword, true);
    } catch (e) {
      console.error('刷新短信列表失败:', e);
    }
  });
  
  // 监听滚动事件，实现滚动加载更多
  smsQueryResultDiv.addEventListener('scroll', function() {
    if (isLoading || !hasMoreData) return;
    
    // 当滚动到距离底部100px时，加载更多数据
    const scrollPosition = this.scrollTop + this.clientHeight;
    const scrollHeight = this.scrollHeight;
    
    if (scrollPosition >= scrollHeight - 100) {
      loadMoreSms();
    }
  });
  
  // 重置分页状态
  function resetPagination() {
    currentPage = 1;
    hasMoreData = true;
    isLoading = false;
  }
  
  // 加载更多短信
  function loadMoreSms() {
    if (isLoading || !hasMoreData) return;
    
    currentPage++;
    querySmsMessages(currentSmsType, currentKeyword, false);
  }
  
  // 获取DOM元素 - 发送短信
  const simSlotSelect = document.getElementById('simSlot');
  const phoneInput = document.getElementById('phone');
  const messageInput = document.getElementById('message');
  const sendBtn = document.getElementById('sendBtn');
  
  // 查询接口相关代码已移除
  
  // 标签页切换功能
  tabs.forEach(tab => {
    tab.addEventListener('click', function() {
      // 移除所有标签页的active类
      tabs.forEach(t => t.classList.remove('active'));
      // 隐藏所有内容区域
      tabContents.forEach(content => content.classList.remove('active'));
      
      // 添加当前标签页的active类
      this.classList.add('active');
      // 显示对应的内容区域
      const tabId = this.getAttribute('data-tab');
      document.getElementById(tabId + 'Tab').classList.add('active');
      
      // 隐藏状态信息
      statusDiv.style.display = 'none';
    });
  });
  
  // 标签页切换时，如果是查询短信标签页，自动刷新短信列表
  tabs.forEach(tab => {
    tab.addEventListener('click', function() {
      const tabId = this.getAttribute('data-tab');
      if (tabId === 'smsQuery') {
        resetPagination();
        querySmsMessages(currentSmsType, currentKeyword, true);
      }
    });
  });
  
  // 查询接口相关代码已移除
  
  // 检查是否有从右键菜单选中的文本
  SharedStorage.getLocal(['selectedText']).then((items) => {
    if (items && items.selectedText) {
      messageInput.value = items.selectedText;
      // 使用后清除存储的文本
      SharedStorage.removeLocal(['selectedText']);
    }
  });
  
  // 从存储中加载设置和SIM卡配置
  SharedStorage.getSync(['serverUrl', 'secret', 'apiConfigData']).then((items) => {
    // 检查是否已配置
    if (!items.serverUrl || !items.secret) {
      showStatus('请先配置SmsForwarder服务器设置', 'error');
    }
    
    // 清空现有选项
    simSlotSelect.innerHTML = '';
    
    // 从apiConfigData中获取sim_info_list
    if (items.apiConfigData && items.apiConfigData.sim_info_list && items.apiConfigData.sim_info_list.value) {
      const simInfoList = items.apiConfigData.sim_info_list.value;
      
      // 检查sim_info_list是否为对象类型
      if (typeof simInfoList === 'object' && simInfoList !== null) {
        console.log('从apiConfigData中获取到sim_info_list:', simInfoList);
        
        // 遍历sim_info_list对象的所有属性（卡槽）
        Object.entries(simInfoList).forEach(([slotId, simInfo]) => {
          if (simInfo) {
            const option = document.createElement('option');
            option.value = slotId; // 使用卡槽ID作为值
            
            // 构建显示文本
            let displayText = '';
            
            // 优先使用carrier_name作为显示名称
            if (simInfo.carrier_name) {
              displayText = simInfo.carrier_name;
            } else {
              displayText = `SIM卡 ${parseInt(slotId) + 1}`;
            }
            
            // 如果有手机号，添加到显示文本中
            if (simInfo.number) {
              displayText += ` (${simInfo.number})`;
            }
            
            option.textContent = displayText;
            simSlotSelect.appendChild(option);
            
            console.log(`添加SIM卡选项: ${displayText}, 值: ${option.value}`);
          }
        });
      } else {
        console.log('sim_info_list不是有效的对象:', simInfoList);
        addDefaultSimOptions();
      }
    } else {
      console.log('未找到sim_info_list配置，使用默认选项');
      addDefaultSimOptions();
    }
  });
  
  // 添加默认的SIM卡选项
  function addDefaultSimOptions() {
    // 添加默认的SIM卡选项
    const option1 = document.createElement('option');
    option1.value = '0';
    option1.textContent = 'SIM卡 1';
    simSlotSelect.appendChild(option1);
    
    const option2 = document.createElement('option');
    option2.value = '1';
    option2.textContent = 'SIM卡 2';
    simSlotSelect.appendChild(option2);
  }
  
  // 发送按钮点击事件
  sendBtn.addEventListener('click', function() {
    const simSlot = simSlotSelect.value;
    const phone = phoneInput.value.trim();
    const message = messageInput.value.trim();
    
    // 验证输入
    if (!phone) {
      showStatus('请输入手机号码', 'error');
      return;
    }
    
    if (!message) {
      showStatus('请输入短信内容', 'error');
      return;
    }
    
    // 发送短信
    sendSms(simSlot, phone, message);
  });
  
  // 查询接口相关代码已移除
  
  // 设置链接点击事件
  settingsLink.addEventListener('click', function() {
    chrome.runtime.openOptionsPage();
  });
  
  // 发送短信函数
  async function sendSms(simSlot, phone, message) {
    // 显示发送中状态
    showStatus('发送中...', '');
    console.log(`准备发送短信，使用卡槽: ${simSlot}, 接收号码: ${phone}`);
    
    // 获取设置
    try {
      const items = await SharedStorage.getSync(['serverUrl', 'secret', 'simInfoList']);
      
      if (!items.serverUrl || !items.secret) {
        showStatus('请先配置SmsForwarder服务器设置', 'error');
        return;
      }
      
      // 记录SIM卡配置信息
      if (items.simInfoList) {
        console.log('发送短信时使用的SIM卡配置:', items.simInfoList);
      }
      
      // 准备请求参数
      // 确保sim_slot是整数
      let simSlotValue = parseInt(simSlot);
      console.log(`解析后的卡槽值: ${simSlotValue}`);
      
      // 如果解析失败或为NaN，使用默认值0
      if (isNaN(simSlotValue)) {
        console.warn(`卡槽值解析失败，使用默认值0`);
        simSlotValue = 0;
      }
      
      console.log('发送短信请求数据:', JSON.stringify({ sim_slot: simSlotValue, phone_numbers: phone, msg_content: message }, null, 2));
      
      // 发送请求
      try {
        const response = await SharedApi.signedPost(items.serverUrl, "/sms/send", items.secret, { sim_slot: simSlotValue, phone_numbers: phone, msg_content: message }, { timeoutMs: 10000 });
        
        if (!response.ok) {
          throw new Error(`HTTP error! Status: ${response.status}`);
        }
        
        const data = await response.json();
        
        if (data.code === 200 || data.code === 0) {
          showStatus('短信发送成功！', 'success');
          // 清空输入
          messageInput.value = '';
          // 保存短信ID用于后续查询
          if (data.data && typeof data.data === 'string') {
            SharedStorage.setLocal({ lastSmsId: data.data });
          }
        } else {
          showStatus(`发送失败: ${data.msg || '未知错误'}`, 'error');
        }
      } catch (error) {
        showStatus(`发送失败: ${error.message}`, 'error');
      }
    } catch (error) {
      showStatus(`发送失败: ${error.message}`, 'error');
    }
  }
  
  // 查询接口相关函数已移除
  
  // 显示状态信息
  function showStatus(message, type) {
    statusDiv.textContent = message;
    statusDiv.className = 'status';
    if (type) {
      statusDiv.classList.add(type);
    }
    statusDiv.style.display = 'block';
  }
  

  
  // 查询短信列表函数
  async function querySmsMessages(smsType, keyword, isReset = true) {
    // 如果已经在加载中，则不重复加载
    if (isLoading) return;
    
    // 设置加载状态
    isLoading = true;
    
    // 显示查询中状态
    showStatus('正在加载短信列表...', 'info');
    
    // 如果是重置查询，则清空结果区域并显示加载中
    if (isReset) {
      smsQueryResultDiv.innerHTML = '<div style="text-align: center; padding: 20px;">加载中...</div>';
      smsQueryResultDiv.style.display = 'block';
    } else {
      // 如果是加载更多，则在结果区域底部添加加载中提示
      const loadingIndicator = document.createElement('div');
      loadingIndicator.id = 'loadingMore';
      loadingIndicator.style.textAlign = 'center';
      loadingIndicator.style.padding = '10px';
      loadingIndicator.style.color = '#666';
      loadingIndicator.textContent = '正在加载更多...';
      
      // 如果已经有表格，则在表格后添加加载提示
      const existingTable = smsQueryResultDiv.querySelector('.sms-table');
      if (existingTable) {
        existingTable.parentNode.insertBefore(loadingIndicator, existingTable.nextSibling);
      } else {
        smsQueryResultDiv.appendChild(loadingIndicator);
      }
    }
    
    // 新增：本地优先渲染（第一页/重置）
    let didRenderFromLocal = false;
    if (isReset || currentPage === 1) {
      try {
        const localItems = await SharedStorage.getLocal(['polledSmsList']);
        const localListRaw = Array.isArray(localItems.polledSmsList) ? localItems.polledSmsList : [];
        // 按时间降序排序
        const localList = localListRaw.slice().sort((a, b) => {
          const ta = a.timestamp || a.date || a.time || 0;
          const tb = b.timestamp || b.date || b.time || 0;
          return tb - ta;
        });
        // 过滤类型与关键字
        const filteredLocal = localList.filter(sms => {
          const tRaw = sms.type;
          const t = typeof tRaw === 'string' ? parseInt(tRaw) : (typeof tRaw === 'number' ? tRaw : DEFAULT_SMS_TYPE);
          const matchesType = parseInt(smsType) === t;
          if (!matchesType) return false;
          if (!keyword) return true;
          const text = [sms.content, sms.name, sms.contact, sms.number, sms.from, sms.to]
            .filter(Boolean)
            .join(' ');
          return text.includes(keyword);
        });
        if (filteredLocal.length > 0) {
          let resultHTML = '<table class="sms-table">';
          resultHTML += '<thead><tr><th>联系人/号码</th><th>时间</th><th>类型</th></tr></thead>';
          resultHTML += '<tbody>';
          filteredLocal.forEach(sms => {
            const date = new Date(sms.timestamp || sms.date || sms.time || 0);
            const formattedDate = `${date.getFullYear()}-${(date.getMonth()+1).toString().padStart(2, '0')}-${date.getDate().toString().padStart(2, '0')} ${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
            const tRaw = sms.type;
            const t = typeof tRaw === 'string' ? parseInt(tRaw) : (typeof tRaw === 'number' ? tRaw : DEFAULT_SMS_TYPE);
            const smsTypeText = (t === 1) ? '接收' : '发送';
            const contact = sms.name || sms.contact || '未知';
            const number = sms.number || sms.from || sms.to || '';
            resultHTML += `<tr class="sms-row">`;
            resultHTML += `<td class="sms-number">${contact}${number ? '<br>' : ''}${number}</td>`;
            resultHTML += `<td class="sms-meta">${formattedDate}</td>`;
            resultHTML += `<td class="sms-meta">${smsTypeText}</td>`;
            resultHTML += `</tr>`;
            resultHTML += `<tr><td colspan="3"><div class="sms-content">${sms.content || ''}</div></td></tr>`;
          });
          resultHTML += '</tbody></table>';
          smsQueryResultDiv.innerHTML = resultHTML;
          
          // 允许向下滚动以从服务端加载更多历史
          hasMoreData = true;
          const loadMoreTip = document.createElement('div');
          loadMoreTip.className = 'load-more-tip';
          loadMoreTip.textContent = '向下滚动加载更多';
          loadMoreTip.style.textAlign = 'center';
          loadMoreTip.style.padding = '10px';
          loadMoreTip.style.color = '#666';
          loadMoreTip.style.fontSize = '12px';
          smsQueryResultDiv.appendChild(loadMoreTip);
          
          showStatus('', '');
          didRenderFromLocal = true;
        }
      } catch (e) {
        console.error('读取本地短信失败:', e);
      }
    }
    if (didRenderFromLocal) {
      // 如果使用了本地数据，跳过首屏接口请求
      const loadingMoreElement = document.getElementById('loadingMore');
      if (loadingMoreElement) {
        loadingMoreElement.remove();
      }
      isLoading = false;
      return;
    }
    
    // 获取设置（服务端回退）
    try {
      const items = await SharedStorage.getSync(['serverUrl', 'secret']);
      
      if (!items.serverUrl || !items.secret) {
        showStatus('请先配置SmsForwarder服务器设置', 'error');
        isLoading = false;
        return;
      }
      
      // 准备请求参数
      const payload = {
        type: parseInt(smsType),
        page_num: currentPage,
        page_size: 20
      };
      
      // 如果有关键字，添加到请求数据中
      if (keyword) {
        payload.keyword = keyword;
      }
      
      // 发送请求
      try {
        const response = await SharedApi.signedPost(items.serverUrl, "/sms/query", items.secret, payload, { timeoutMs: 10000 });
           
           if (!response.ok) {
             throw new Error(`HTTP error! Status: ${response.status}`);
           }
           
           const data = await response.json();
        console.log('查询短信列表响应:', data);
        // 移除加载更多的提示
        const loadingMoreElement = document.getElementById('loadingMore');
        if (loadingMoreElement) {
          loadingMoreElement.remove();
        }
        
        // 处理查询结果
        if (data.code === 200 || data.code === 0) {
          // 判断是否还有更多数据
          hasMoreData = data.data && Array.isArray(data.data) && data.data.length === 20;
          
          // 格式化并显示查询结果
          if (data.data && Array.isArray(data.data) && data.data.length > 0) {
            // 创建结果HTML
            let resultHTML = '';
            
            // 如果是重置查询，则创建新表格
            if (isReset) {
              resultHTML = '<table class="sms-table">';
              resultHTML += '<thead><tr><th>联系人/号码</th><th>时间</th><th>类型</th></tr></thead>';
              resultHTML += '<tbody>';
            }
            
            // 遍历短信数据
            data.data.forEach(sms => {
              // 格式化日期 - 支持date或time字段
              const date = new Date(sms.date || sms.time || 0);
              const formattedDate = `${date.getFullYear()}-${(date.getMonth()+1).toString().padStart(2, '0')}-${date.getDate().toString().padStart(2, '0')} ${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
              
              // 格式化短信类型 - 支持数字或字符串类型
              const smsTypeText = (sms.type === 1 || sms.type === '1') ? '接收' : '发送';
              
              // 获取联系人信息 - 支持name或contact字段
              const contact = sms.name || sms.contact || '未知';
              const number = sms.number || sms.from || sms.to || '';
              
              // 添加联系人/号码行
              resultHTML += `<tr class="sms-row">`;
              resultHTML += `<td class="sms-number">${contact}${number ? '<br>' : ''}${number}</td>`;
              resultHTML += `<td class="sms-meta">${formattedDate}</td>`;
              resultHTML += `<td class="sms-meta">${smsTypeText}</td>`;
              resultHTML += `</tr>`;
              
              // 添加内容行
              resultHTML += `<tr><td colspan="3"><div class="sms-content">${sms.content}</div></td></tr>`;
            });
            
            // 如果是重置查询，则直接设置HTML
            if (isReset) {
              resultHTML += '</tbody></table>';
              smsQueryResultDiv.innerHTML = resultHTML;
              
              // 如果有更多数据，添加加载更多提示
              if (hasMoreData) {
                const loadMoreTip = document.createElement('div');
                loadMoreTip.className = 'load-more-tip';
                loadMoreTip.textContent = '向下滚动加载更多';
                loadMoreTip.style.textAlign = 'center';
                loadMoreTip.style.padding = '10px';
                loadMoreTip.style.color = '#666';
                loadMoreTip.style.fontSize = '12px';
                smsQueryResultDiv.appendChild(loadMoreTip);
              }
            } else {
              // 如果是加载更多，则追加到现有表格
              const tbody = smsQueryResultDiv.querySelector('.sms-table tbody');
              if (tbody) {
                tbody.insertAdjacentHTML('beforeend', resultHTML);
                
                // 更新加载更多提示
                const loadMoreTip = smsQueryResultDiv.querySelector('.load-more-tip');
                if (loadMoreTip) {
                  if (hasMoreData) {
                    loadMoreTip.textContent = '向下滚动加载更多';
                  } else {
                    loadMoreTip.textContent = '已加载全部短信';
                  }
                } else if (hasMoreData) {
                  // 如果没有提示但还有更多数据，添加提示
                  const newLoadMoreTip = document.createElement('div');
                  newLoadMoreTip.className = 'load-more-tip';
                  newLoadMoreTip.textContent = '向下滚动加载更多';
                  newLoadMoreTip.style.textAlign = 'center';
                  newLoadMoreTip.style.padding = '10px';
                  newLoadMoreTip.style.color = '#666';
                  newLoadMoreTip.style.fontSize = '12px';
                  smsQueryResultDiv.appendChild(newLoadMoreTip);
                }
              }
            }
          } else {
            // 如果是重置查询且没有数据，显示无数据提示
            if (isReset) {
              smsQueryResultDiv.innerHTML = '<div style="text-align: center; padding: 20px; color: #666;">暂无短信记录</div>';
              showStatus('暂无短信记录', 'info');
            } else {
              // 如果是加载更多但没有更多数据
              hasMoreData = false;
              const loadMoreTip = smsQueryResultDiv.querySelector('.load-more-tip');
              if (loadMoreTip) {
                loadMoreTip.textContent = '已加载全部短信';
              } else {
                const newLoadMoreTip = document.createElement('div');
                newLoadMoreTip.className = 'load-more-tip';
                newLoadMoreTip.textContent = '已加载全部短信';
                newLoadMoreTip.style.textAlign = 'center';
                newLoadMoreTip.style.padding = '10px';
                newLoadMoreTip.style.color = '#666';
                newLoadMoreTip.style.fontSize = '12px';
                smsQueryResultDiv.appendChild(newLoadMoreTip);
              }
            }
          }
        } else {
          showStatus(`加载失败: ${data.msg || '未知错误'}`, 'error');
          if (isReset) {
            smsQueryResultDiv.innerHTML = `<div style="text-align: center; padding: 20px; color: #721c24;">加载失败: ${data.msg || '未知错误'}</div>`;
          }
        }
      } catch (error) {
        console.error('查询短信出错:', error);
        showStatus(`加载失败: ${error.message}`, 'error');
        if (isReset) {
          smsQueryResultDiv.innerHTML = `<div style="text-align: center; padding: 20px; color: #721c24;">加载失败: ${error.message}</div>`;
        }
      }
    } catch (error) {
      console.error('查询短信出错:', error);
      showStatus(`加载失败: ${error.message}`, 'error');
      if (isReset) {
        smsQueryResultDiv.innerHTML = `<div style="text-align: center; padding: 20px; color: #721c24;">加载失败: ${error.message}</div>`;
      }
    }
    
    // 重置加载状态
    isLoading = false;
  }
});