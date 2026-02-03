
import * as vscode from 'vscode';
import { KernelsApi, KernelSpec } from '../api/kernels';
import { RemoteKernelSession } from './kernelSession';

export class RemoteKernelController {
    private controller: vscode.NotebookController;
    private executions = new Map<string, RemoteKernelSession>();

    constructor(
        private readonly kernelSpec: KernelSpec,
        private readonly kernelsApi: KernelsApi,
        private readonly serverUrl: string,
        private readonly token: string
    ) {
        this.controller = vscode.notebooks.createNotebookController(
            `jupyterhub-remote-${kernelSpec.name}`,
            'jupyter-notebook',
            `Remote: ${kernelSpec.spec.display_name}`,
            // handler
            this.executeHandler.bind(this)
        );
        this.controller.supportedLanguages = [kernelSpec.spec.language.toLowerCase()];
        this.controller.description = 'JupyterHub Remote Kernel';
        this.controller.detail = `Language: ${kernelSpec.spec.language}`;
    }

    dispose() {
        this.controller.dispose();
        this.executions.forEach(session => session.dispose());
        this.executions.clear();
    }

    private async executeHandler(
        cells: vscode.NotebookCell[],
        _notebook: vscode.NotebookDocument,
        _controller: vscode.NotebookController
    ): Promise<void> {
        // 1. 获取或创建 Kernel Session
        let session = this.executions.get(_notebook.uri.toString());
        if (!session) {
            try {
                // Determine the notebook path for the kernel context
                let notebookPath: string | undefined;
                if (_notebook.uri.scheme === 'jupyterhub') {
                    // Jupyter expects relative path to the notebook file (e.g. folder/notebook.ipynb)
                    notebookPath = _notebook.uri.path.replace(/^\//, '');
                }

                // 启动一个新的 Kernel
                // Pass the full notebook path so Jupyter knows the context
                const kernel = await this.kernelsApi.startKernel(this.kernelSpec.name, notebookPath);

                // 构造 WebSocket URL (确保处理 https -> wss)
                const baseUrl = this.serverUrl.replace(/^http/, 'ws');
                const wsUrl = `${baseUrl}/api/kernels/${kernel.id}/channels`;

                session = new RemoteKernelSession(wsUrl, this.token);
                await session.connect();

                // 强制修正 Python 环境的路径 (Double Check)
                // 即使 Server 没正确处理 path 参数，这段代码也能保证 import 正常
                if (notebookPath && this.kernelSpec.spec.language.toLowerCase() === 'python') {
                    const lastSlash = notebookPath.lastIndexOf('/');
                    if (lastSlash !== -1) {
                        const cwd = notebookPath.substring(0, lastSlash);
                        // Escape single quotes for safe injection into Python string
                        const escapedCwd = cwd.replace(/'/g, "\\'");
                        
                        // 1. 切换工作目录
                        // 2. 将当前目录加入 sys.path 首位，确保能 import 同级文件
                        const safeCode = `
import os
import sys
try:
    # 尝试切换到笔记本所在目录
    target_cwd = '${escapedCwd}'
    if target_cwd != '':
        if os.path.exists(target_cwd):
            os.chdir(target_cwd)
        else:
            # 可能是相对于 home 的路径
            home_rel = os.path.expanduser('~/' + target_cwd)
            if os.path.exists(home_rel):
                os.chdir(home_rel)
    
    # 确保当前目录在 path 中
    cwd = os.getcwd()
    if cwd not in sys.path:
        sys.path.insert(0, cwd)
except Exception:
    pass
`;
                        // 静默执行初始化代码
                        await session.executeCode(safeCode, () => {});
                    }
                }

                this.executions.set(_notebook.uri.toString(), session);

                // 监听 Notebook 关闭以清理
                // (此处简化，未实现自动清理逻辑)

            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to start kernel: ${err.message}`);
                return;
            }
        }

        // 2. 执行 Cell
        for (const cell of cells) {
            await this.executeCell(cell, session);
        }
    }

    private async executeCell(cell: vscode.NotebookCell, session: RemoteKernelSession): Promise<void> {
        const execution = this.controller.createNotebookCellExecution(cell);
        execution.executionOrder = ++this.executionOrder;
        execution.start(Date.now()); // Set start time

        try {
            // Clear previous outputs to match JupyterWeb behavior
            execution.clearOutput();

            await session.executeCode(cell.document.getText(), (msg) => {
                this.handleIOPubMessage(execution, msg);
            });
            execution.end(true, Date.now());
        } catch (err) {
            execution.replaceOutput([
                new vscode.NotebookCellOutput([
                    vscode.NotebookCellOutputItem.error(err as Error)
                ])
            ]);
            execution.end(false, Date.now());
        }
    }

    private executionOrder = 0;

    private handleIOPubMessage(execution: vscode.NotebookCellExecution, msg: any) {
        const msgType = msg.header.msg_type;
        const content = msg.content;

        if (msgType === 'clear_output') {
            execution.clearOutput();
        } else if (msgType === 'stream') {
            const text = content.text;
            if (content.name === 'stdout') {
                execution.appendOutput(new vscode.NotebookCellOutput([
                    vscode.NotebookCellOutputItem.text(text, 'text/plain')
                ]));
            } else if (content.name === 'stderr') {
                // 显示为 stderr 样式通常还是 text/plain 但可能想区分
                execution.appendOutput(new vscode.NotebookCellOutput([
                    vscode.NotebookCellOutputItem.text(text, 'application/vnd.code.notebook.stderr')
                ]));
            }
        } else if (msgType === 'execute_result' || msgType === 'display_data') {
            const data = content.data;
            const items: vscode.NotebookCellOutputItem[] = [];

            // 遍历 MIME types
            for (const key in data) {
                let mimeType = key;
                let value = data[key];
                // 处理 JSON 数据
                if (typeof value === 'object') {
                    // some mimetypes expect string, some object?
                    // VSCode generally handles objects for application/json
                }
                items.push(new vscode.NotebookCellOutputItem(this.encodeData(value), mimeType));
            }
            execution.appendOutput(new vscode.NotebookCellOutput(items));
        } else if (msgType === 'error') {
            execution.appendOutput(new vscode.NotebookCellOutput([
                vscode.NotebookCellOutputItem.error({
                    name: content.ename,
                    message: content.evalue,
                    stack: content.traceback.join('\n')
                })
            ]));
        }
    }

    private encodeData(data: any): Uint8Array {
        if (typeof data === 'string') {
            return new TextEncoder().encode(data);
        }
        // 如果是数组或其他对象，尝试 JSON stringify
        return new TextEncoder().encode(JSON.stringify(data));
    }
}
