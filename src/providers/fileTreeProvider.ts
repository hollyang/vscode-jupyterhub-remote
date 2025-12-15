/**
 * 文件树提供者
 * 实现 VSCode TreeDataProvider 接口
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { ContentsApi, ContentModel, ContentType } from '../api/contents';
import { ConfigManager } from '../utils/config';

type ClipboardAction = 'copy' | 'cut';

interface ClipboardEntry {
    action: ClipboardAction;
    path: string;
    name: string;
    type: ContentType;
}

export class FileTreeItem extends vscode.TreeItem {
    constructor(
        public readonly model: ContentModel,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        private readonly iconResolver?: (model: ContentModel) => vscode.ThemeIcon | vscode.Uri | { light: vscode.Uri; dark: vscode.Uri }
    ) {
        super(model.name, collapsibleState);

        this.tooltip = model.path;
        this.contextValue = model.type;

        // 设置图标
        if (iconResolver) {
            this.iconPath = iconResolver(model);
        } else if (model.type === 'directory') {
            this.iconPath = new vscode.ThemeIcon('folder');
        } else if (model.type === 'notebook') {
            this.iconPath = new vscode.ThemeIcon('notebook');
        } else {
            this.iconPath = vscode.ThemeIcon.File;
        }

        // 文件可以直接点击打开
        if (model.type === 'file' || model.type === 'notebook') {
            this.command = {
                command: 'jupyterhub.openFile',
                title: '打开文件',
                arguments: [this]
            };
        }
    }
}

export class FileTreeProvider implements vscode.TreeDataProvider<FileTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<FileTreeItem | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private contentsApi: ContentsApi | null;
    private refreshTimer: NodeJS.Timeout | undefined;
    private extensionUri: vscode.Uri | null = null;
    private clipboard: ClipboardEntry | null = null;
    private dragAndDropController: vscode.TreeDragAndDropController<FileTreeItem>;

    constructor() {
        this.contentsApi = null;
        this.dragAndDropController = new FileTreeDragAndDropController(this);
    }

    getDragAndDropController(): vscode.TreeDragAndDropController<FileTreeItem> {
        return this.dragAndDropController;
    }

    setExtensionUri(extensionUri: vscode.Uri) {
        this.extensionUri = extensionUri;
    }

    /**
     * 设置 API 客户端
     */
    setContentsApi(api: ContentsApi) {
        this.contentsApi = api;
        this.refresh();
        this.startAutoRefresh();
    }

    /**
     * 清除 API 客户端
     */
    clearContentsApi() {
        this.contentsApi = null;
        this.stopAutoRefresh();
        this.refresh();
    }

    private startAutoRefresh() {
        this.stopAutoRefresh();
        // 获取刷新间隔
        const interval = ConfigManager.getFileRefreshInterval();
        if (interval > 0) {
            this.refreshTimer = setInterval(() => {
                this.refresh();
            }, interval * 1000);
        }
    }

    private stopAutoRefresh() {
        if (this.refreshTimer) {
            clearInterval(this.refreshTimer);
            this.refreshTimer = undefined;
        }
    }

    /**
     * 刷新树
     */
    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    /**
     * 获取树节点
     */
    getTreeItem(element: FileTreeItem): vscode.TreeItem {
        return element;
    }

    /**
     * 获取子节点
     */
    async getChildren(element?: FileTreeItem): Promise<FileTreeItem[]> {
        if (!this.contentsApi) {
            return [];
        }

        try {
            const path = element ? element.model.path : '';
            const content = await this.contentsApi.listDirectory(path);

            // 排序: 文件夹优先，然后按名称排序
            content.sort((a, b) => {
                if (a.type === b.type) {
                    return a.name.localeCompare(b.name);
                }
                return a.type === 'directory' ? -1 : 1;
            });

            return content.map(item => {
                const collapsibleState = item.type === 'directory'
                    ? vscode.TreeItemCollapsibleState.Collapsed
                    : vscode.TreeItemCollapsibleState.None;
                return new FileTreeItem(item, collapsibleState, (m) => this.resolveIcon(m));
            });
        } catch (error: any) {
            vscode.window.showErrorMessage(`获取文件列表失败: ${error.message}`);
            return [];
        }
    }

    private resolveIcon(model: ContentModel): vscode.ThemeIcon | vscode.Uri | { light: vscode.Uri; dark: vscode.Uri } {
        if (model.type === 'directory') {
            return new vscode.ThemeIcon('folder');
        }
        const ext = path.extname(model.name).toLowerCase().replace('.', '');

        // Jupyter Server 可能会把可被 jupytext 识别的 .py/.md 等标成 notebook，
        // 图标按扩展名优先（只有 .ipynb 才用 notebook/jupyter 图标）
        if (model.type === 'notebook' && ext === 'ipynb') {
            return this.getIconByName('ipynb') ?? new vscode.ThemeIcon('notebook');
        }

        const icon = this.getIconByName(ext);
        if (icon) {
            return icon;
        }

        if (model.type === 'notebook') {
            return new vscode.ThemeIcon('notebook');
        }

        // 常见无扩展名的文件
        const lowerName = model.name.toLowerCase();
        if (lowerName === 'makefile' || lowerName === 'dockerfile') {
            return new vscode.ThemeIcon('settings-gear');
        }

        return vscode.ThemeIcon.File;
    }

    private getIconByName(ext: string): { light: vscode.Uri; dark: vscode.Uri } | null {
        if (!this.extensionUri) {
            return null;
        }

        const map: Record<string, string> = {
            go: 'go.svg',
            py: 'python.svg',
            js: 'javascript.svg',
            jsx: 'javascript.svg',
            ts: 'typescript.svg',
            tsx: 'typescript.svg',
            ipynb: 'ipynb.svg',
            json: 'json.svg',
            md: 'markdown.svg',
            yml: 'yaml.svg',
            yaml: 'yaml.svg',
            sh: 'shell.svg',
            sql: 'sql.svg'
        };

        const file = map[ext];
        if (!file) {
            return null;
        }

        const uri = vscode.Uri.joinPath(this.extensionUri, 'resources', 'file-icons', file);
        return { light: uri, dark: uri };
    }

    /**
     * 获取父目录路径
     */
    private getParentPath(item?: FileTreeItem): string {
        if (!item) {
            return '';
        }
        // 如果选中是文件夹，直接在该文件夹下创建
        if (item.model.type === 'directory') {
            return item.model.path;
        }
        // 如果选中是文件，则在其父目录下创建
        // 移除最后一段文件名
        const parts = item.model.path.split('/');
        parts.pop();
        return parts.join('/');
    }

    /**
     * 创建文件
     */
    async createFile(parent?: FileTreeItem): Promise<void> {
        if (!this.contentsApi) {
            vscode.window.showErrorMessage('未连接到服务器');
            return;
        }

        const fileName = await vscode.window.showInputBox({
            prompt: '输入文件名',
            placeHolder: 'example.txt'
        });

        if (!fileName) {
            return;
        }

        try {
            const parentPath = this.getParentPath(parent);
            // 拼接路径，注意处理根目录 parentPath 为空的边界情况
            const filePath = parentPath ? `${parentPath}/${fileName}` : fileName;

            // 根据扩展名判断文件类型
            if (fileName.endsWith('.ipynb')) {
                // 创建空 Notebook
                const emptyNotebook = {
                    cells: [],
                    metadata: {},
                    nbformat: 4,
                    nbformat_minor: 5
                };
                await this.contentsApi.save(filePath, emptyNotebook, 'json', 'notebook');
            } else {
                // 创建空文本文件
                await this.contentsApi.save(filePath, '', 'text', 'file');
            }

            this.refresh();
            vscode.window.showInformationMessage(`文件 "${fileName}" 创建成功`);
        } catch (error: any) {
            vscode.window.showErrorMessage(`创建文件失败: ${error.message}`);
        }
    }

    /**
     * 创建文件夹
     */
    async createFolder(parent?: FileTreeItem): Promise<void> {
        if (!this.contentsApi) {
            vscode.window.showErrorMessage('未连接到服务器');
            return;
        }

        const folderName = await vscode.window.showInputBox({
            prompt: '输入文件夹名',
            placeHolder: 'new-folder'
        });

        if (!folderName) {
            return;
        }

        try {
            const parentPath = this.getParentPath(parent);
            const folderPath = parentPath ? `${parentPath}/${folderName}` : folderName;

            await this.contentsApi.createDirectory(folderPath);
            this.refresh();
            vscode.window.showInformationMessage(`文件夹 "${folderName}" 创建成功`);
        } catch (error: any) {
            vscode.window.showErrorMessage(`创建文件夹失败: ${error.message}`);
        }
    }

    /**
     * 删除项目
     */
    async deleteItem(item: FileTreeItem): Promise<void> {
        if (!this.contentsApi) {
            vscode.window.showErrorMessage('未连接到服务器');
            return;
        }

        const confirmation = await vscode.window.showWarningMessage(
            `确定要删除 "${item.model.name}" 吗？`,
            { modal: true },
            '删除'
        );

        if (confirmation !== '删除') {
            return;
        }

        try {
            await this.contentsApi.delete(item.model.path);
            this.refresh();
            vscode.window.showInformationMessage(`"${item.model.name}" 已删除`);
        } catch (error: any) {
            vscode.window.showErrorMessage(`删除失败: ${error.message}`);
        }
    }

    /**
     * 重命名项目
     */
    async renameItem(item: FileTreeItem): Promise<void> {
        if (!this.contentsApi) {
            vscode.window.showErrorMessage('未连接到服务器');
            return;
        }

        const newName = await vscode.window.showInputBox({
            prompt: '输入新名称',
            value: item.model.name
        });

        if (!newName || newName === item.model.name) {
            return;
        }

        try {
            const parentPath = path.dirname(item.model.path);
            const newPath = parentPath === '.'
                ? newName
                : `${parentPath}/${newName}`;

            await this.contentsApi.rename(item.model.path, newPath);
            this.refresh();
            vscode.window.showInformationMessage(`已重命名为 "${newName}"`);
        } catch (error: any) {
            vscode.window.showErrorMessage(`重命名失败: ${error.message}`);
        }
    }

    /**
     * 上传文件
     */
    async uploadFile(parent?: FileTreeItem): Promise<void> {
        if (!this.contentsApi) {
            vscode.window.showErrorMessage('未连接到服务器');
            return;
        }

        const fileUris = await vscode.window.showOpenDialog({
            canSelectMany: false,
            openLabel: '上传'
        });

        if (!fileUris || fileUris.length === 0) {
            return;
        }

        try {
            const localUri = fileUris[0];
            const fileName = path.basename(localUri.fsPath);
            const fileContent = await vscode.workspace.fs.readFile(localUri);
            const base64Content = Buffer.from(fileContent).toString('base64');

            const parentPath = parent ? parent.model.path : '';
            const remotePath = parentPath ? `${parentPath}/${fileName}` : fileName;

            await this.contentsApi.uploadFile(remotePath, base64Content, 'base64');
            this.refresh();
            vscode.window.showInformationMessage(`文件 "${fileName}" 上传成功`);
        } catch (error: any) {
            vscode.window.showErrorMessage(`上传文件失败: ${error.message}`);
        }
    }

    /**
     * 下载文件
     */
    async downloadFile(item: FileTreeItem): Promise<void> {
        if (!this.contentsApi) {
            vscode.window.showErrorMessage('未连接到服务器');
            return;
        }

        if (item.model.type === 'directory') {
            vscode.window.showErrorMessage('无法下载目录');
            return;
        }

        try {
            const saveUri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file(item.model.name)
            });

            if (!saveUri) {
                return;
            }

            const content = await this.contentsApi.downloadFile(item.model.path, 'base64');
            const buffer = Buffer.from(content, 'base64');

            await vscode.workspace.fs.writeFile(saveUri, buffer);
            vscode.window.showInformationMessage(`文件 "${item.model.name}" 下载成功`);
        } catch (error: any) {
            vscode.window.showErrorMessage(`下载文件失败: ${error.message}`);
        }
    }

    async copyItem(item: FileTreeItem): Promise<void> {
        if (!this.contentsApi) {
            vscode.window.showErrorMessage('未连接到服务器');
            return;
        }
        if (item.model.type !== 'file' && item.model.type !== 'directory' && item.model.type !== 'notebook') {
            return;
        }

        this.clipboard = {
            action: 'copy',
            path: item.model.path,
            name: item.model.name,
            type: item.model.type
        };
        await vscode.commands.executeCommand('setContext', 'jupyterhub.clipboard.hasItem', true);
        await vscode.commands.executeCommand('setContext', 'jupyterhub.clipboard.action', 'copy');
        vscode.window.showInformationMessage(`已复制: ${item.model.path}`);
    }

    async cutItem(item: FileTreeItem): Promise<void> {
        if (!this.contentsApi) {
            vscode.window.showErrorMessage('未连接到服务器');
            return;
        }
        if (item.model.type !== 'file' && item.model.type !== 'directory' && item.model.type !== 'notebook') {
            return;
        }

        this.clipboard = {
            action: 'cut',
            path: item.model.path,
            name: item.model.name,
            type: item.model.type
        };
        await vscode.commands.executeCommand('setContext', 'jupyterhub.clipboard.hasItem', true);
        await vscode.commands.executeCommand('setContext', 'jupyterhub.clipboard.action', 'cut');
        vscode.window.showInformationMessage(`已剪切: ${item.model.path}`);
    }

    async pasteItem(target?: FileTreeItem): Promise<void> {
        if (!this.contentsApi) {
            vscode.window.showErrorMessage('未连接到服务器');
            return;
        }
        if (!this.clipboard) {
            vscode.window.showWarningMessage('剪贴板为空');
            return;
        }

        const destDir = this.getParentPath(target);

        // 允许在 Root 粘贴（destDir 为空字符串）
        if (this.clipboard.type === 'directory' && destDir && (destDir === this.clipboard.path || destDir.startsWith(`${this.clipboard.path}/`))) {
            vscode.window.showErrorMessage('不能将目录移动/复制到其自身或子目录中');
            return;
        }

        try {
            if (this.clipboard.action === 'cut') {
                const newPath = destDir ? `${destDir}/${this.clipboard.name}` : this.clipboard.name;
                if (newPath === this.clipboard.path) {
                    vscode.window.showInformationMessage('目标路径与源路径相同，已忽略');
                    return;
                }

                await this.contentsApi.rename(this.clipboard.path, newPath);
                this.clipboard = null;
                await vscode.commands.executeCommand('setContext', 'jupyterhub.clipboard.hasItem', false);
                await vscode.commands.executeCommand('setContext', 'jupyterhub.clipboard.action', '');
                vscode.window.showInformationMessage(`已移动到: ${newPath}`);
            } else {
                const result = await this.contentsApi.copy(destDir, this.clipboard.path);
                vscode.window.showInformationMessage(`已复制到: ${result.path}`);
            }

            this.refresh();
        } catch (error: any) {
            vscode.window.showErrorMessage(`粘贴失败: ${error.message}`);
        }
    }

    async moveItemsToDir(items: Array<{ path: string; name: string; type: ContentType }>, destDir: string): Promise<void> {
        if (!this.contentsApi) {
            vscode.window.showErrorMessage('未连接到服务器');
            return;
        }

        for (const src of items) {
            if (src.type === 'directory' && destDir && (destDir === src.path || destDir.startsWith(`${src.path}/`))) {
                vscode.window.showErrorMessage('不能将目录移动到其自身或子目录中');
                continue;
            }

            const newPath = destDir ? `${destDir}/${src.name}` : src.name;
            if (newPath === src.path) {
                continue;
            }

            await this.contentsApi.rename(src.path, newPath);
        }
    }
}

class FileTreeDragAndDropController implements vscode.TreeDragAndDropController<FileTreeItem> {
    readonly dragMimeTypes = ['application/vnd.code.tree.jupyterhubFiles'];
    readonly dropMimeTypes = ['application/vnd.code.tree.jupyterhubFiles'];

    constructor(private readonly provider: FileTreeProvider) { }

    handleDrag(source: readonly FileTreeItem[], dataTransfer: vscode.DataTransfer): void {
        const payload = source
            .filter(s => s.model.type === 'file' || s.model.type === 'directory' || s.model.type === 'notebook')
            .map(s => ({ path: s.model.path, name: s.model.name, type: s.model.type }));
        dataTransfer.set('application/vnd.code.tree.jupyterhubFiles', new vscode.DataTransferItem(JSON.stringify(payload)));
    }

    async handleDrop(target: FileTreeItem | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
        const item = dataTransfer.get('application/vnd.code.tree.jupyterhubFiles');
        if (!item) {
            return;
        }

        const text = await item.asString();
        let payload: Array<{ path: string; name: string; type: ContentType }> = [];
        try {
            payload = JSON.parse(text);
        } catch {
            return;
        }

        const destDir = target?.model.type === 'directory'
            ? target.model.path
            : (target ? path.posix.dirname(target.model.path).replace(/^\.$/, '') : '');

        await this.provider.moveItemsToDir(payload, destDir);
        this.provider.refresh();
    }
}
