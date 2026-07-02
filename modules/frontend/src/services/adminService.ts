/*
 * Copyright 2018 Comcast Cable Communications Management, LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import api from './api';

export interface UserApiResponse {
  id: string;
  userName?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  isSuper?: boolean;
  isSupport?: boolean;
  lockStatus?: string;
  created?: string | number;
}

type PermOp = 'MakeSuper' | 'RemoveSuper' | 'MakeSupport' | 'RemoveSupport';

const PERM_OP_TO_STATUS: Record<PermOp, string> = {
  MakeSuper:     'makesuper',
  RemoveSuper:   'removesuper',
  MakeSupport:   'makesupport',
  RemoveSupport: 'removesupport',
};

export const adminService = {
  getUserByIdOrName(usernameOrId: string) {
    return api.get<UserApiResponse>(`/users/lookupuser/${encodeURIComponent(usernameOrId)}`);
  },

  lockUser(userId: string) {
    return api.put<UserApiResponse>(`/users/${encodeURIComponent(userId)}/lock`, {});
  },

  unlockUser(userId: string) {
    return api.put<UserApiResponse>(`/users/${encodeURIComponent(userId)}/unlock`, {});
  },

  updatePermission(userId: string, op: PermOp) {
    const status = PERM_OP_TO_STATUS[op];
    return api.put<UserApiResponse>(`/users/${encodeURIComponent(userId)}/update/${encodeURIComponent(status)}`, {});
  },
};
